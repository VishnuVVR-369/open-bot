#!/usr/bin/env node
// Boots the built worker (apps/worker/dist/worker.mjs) and pages (apps/pages/dist/pages.mjs)
// bundles the way Railway starts them, to catch what only the bundle can get wrong: a module left
// out of it (ERR_MODULE_NOT_FOUND), a dependency that breaks when bundled, a crash at startup.
// Run it as `pnpm test:artifacts` (scripts/test/artifacts.sh), which builds both and provides the
// database. Run directly, it needs the two builds and TEST_DATABASE_URL, a Postgres server it may
// create databases on (scripts/test/pg.sh starts one; never the development database).
// For each artifact it creates a fresh database, runs `pnpm db:migrate` on it, starts the bundle
// with only the variables below (like `env -i`: nothing is inherited, so no real secret, token or
// address can leak in), with every outside service at 127.0.0.1:1, waits until `/healthz`
// answers 200 (failing at once if the process exits), then sends SIGTERM and requires exit code 0
// and no module resolution error in the output. Each wait has a timeout; on failure it prints the
// process output and exits 1. It refuses the development database's port (54329).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The development database's port (docker-compose.yml), which this script never touches. */
const DEV_DATABASE_PORT = "54329";

/** Where every outside service points: nothing listens on port 1, so a call fails at once. */
export const NOWHERE = "http://127.0.0.1:1";

/** A port nothing listens on right now. */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const secret = () => randomBytes(32).toString("base64");

/** The artifacts, each with the exact environment it starts with. */
export function artifacts(home) {
  return [
    {
      name: "worker",
      file: path.join(root, "apps/worker/dist/worker.mjs"),
      env: ({ port, databaseUrl }) => ({
        NODE_ENV: "production",
        HOME: home,
        DATABASE_URL: databaseUrl,
        WORKER_PORT: String(port),
        WORKER_SECRET: secret(),
        ENCRYPTION_KEY: secret(),
        BOTD_URL: NOWHERE,
        BOTD_TOKEN: secret(),
        APP_URL: NOWHERE,
        MODEL_PROXY_URL: NOWHERE,
        OPENAI_API_BASE_URL: NOWHERE,
        OPEN_BOT_PLAN_BASE_URL: NOWHERE,
        TELEGRAM_API_BASE_URL: NOWHERE,
        GOOGLE_BASE_URL: NOWHERE,
        NOTION_MCP_URL: NOWHERE,
        FCM_API_BASE_URL: NOWHERE,
        HOST_CODEX_AUTH_FILE: path.join(home, "no-codex-auth.json"),
        HOST_CODEX_BIN: path.join(home, "no-codex"),
      }),
    },
    {
      name: "pages",
      file: path.join(root, "apps/pages/dist/pages.mjs"),
      env: ({ port, databaseUrl }) => ({
        NODE_ENV: "production",
        HOME: home,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        PAGES_SECRET: secret(),
        PAGES_URL: `http://127.0.0.1:${port}`,
        APP_URL: NOWHERE,
      }),
    },
  ];
}

/** Output that means the bundle is broken even when the process stays up (a lazy import failed). */
export const MODULE_ERROR = /ERR_MODULE_NOT_FOUND|Cannot find (module|package) /;

/**
 * Starts `node <file>` with exactly `env`, waits until `healthUrl` answers 200, sends SIGTERM and
 * waits for exit code 0. Resolves to `{ ok: true }` or `{ ok: false, reason }`; `output` holds
 * what the process printed either way.
 */
export async function boot({
  file,
  env,
  healthUrl,
  readyTimeoutMs = 30_000,
  exitTimeoutMs = 10_000,
  pollMs = 100,
}) {
  const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  // "close" comes after the output streams end, so `output` is complete once it resolves.
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let exit = null;
  void exited.then((result) => (exit = result));
  const describe = ({ code, signal, error }) =>
    error ? error.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
  const wait = (ms) => {
    let timer;
    const elapsed = new Promise((resolve) => (timer = setTimeout(resolve, ms, null)));
    return Promise.race([exited, elapsed]).finally(() => clearTimeout(timer));
  };
  const fail = (reason) => ({ ok: false, reason, output });

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exit) return fail(`${describe(exit)} before it was ready`);
    if (await healthy(healthUrl)) break;
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      await exited;
      return fail(`${healthUrl} did not answer 200 within ${readyTimeoutMs} ms`);
    }
    // The next poll, or the exit, whichever comes first.
    await wait(pollMs);
  }

  child.kill("SIGTERM");
  const stopped = await wait(exitTimeoutMs);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
    return fail(`did not exit within ${exitTimeoutMs} ms of SIGTERM`);
  }
  if (stopped.code !== 0) return fail(`${describe(stopped)} after SIGTERM`);
  if (MODULE_ERROR.test(output)) return fail("printed a module resolution error");
  return { ok: true, output };
}

async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Creates a database on the server at `serverUrl` and returns its URL. */
async function createDatabase(serverUrl, name) {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(serverUrl, name) {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

async function main() {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (!serverUrl) {
    console.error("TEST_DATABASE_URL is not set; run `pnpm test:artifacts`, which provides one.");
    return 1;
  }
  if (new URL(serverUrl).port === DEV_DATABASE_PORT) {
    console.error("TEST_DATABASE_URL points at the development database; use scripts/test/pg.sh.");
    return 1;
  }
  const home = mkdtempSync(path.join(os.tmpdir(), "boot-artifacts-"));
  let failed = false;
  try {
    for (const artifact of artifacts(home)) {
      const name = `boot_${artifact.name}_${process.pid}`;
      const databaseUrl = await createDatabase(serverUrl, name);
      try {
        const migrate = spawnSync("pnpm", ["--silent", "db:migrate"], {
          cwd: root,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          encoding: "utf8",
        });
        if (migrate.status !== 0) {
          console.error(`Migrations failed:\n${migrate.stdout}${migrate.stderr}`);
          failed = true;
          continue;
        }
        const port = await freePort();
        const started = Date.now();
        const outcome = await boot({
          file: artifact.file,
          env: artifact.env({ port, databaseUrl }),
          healthUrl: `http://127.0.0.1:${port}/healthz`,
        });
        if (outcome.ok) {
          console.log(`${artifact.name}: ready and stopped cleanly in ${Date.now() - started} ms`);
        } else {
          failed = true;
          console.error(`${artifact.name}: ${outcome.reason}\n--- output ---\n${outcome.output}`);
        }
      } finally {
        await dropDatabase(serverUrl, name);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
