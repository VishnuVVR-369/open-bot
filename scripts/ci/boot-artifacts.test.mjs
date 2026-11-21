// Unit tests for the built-artifact boot check (scripts/ci/boot-artifacts.mjs): `pnpm test:scripts`.
// Each case boots a small Node server written to a temp folder in place of a real bundle.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NOWHERE, artifacts, boot, freePort } from "./boot-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = mkdtempSync(path.join(os.tmpdir(), "boot-artifacts-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
/** Writes a server whose `/healthz` answers `status`, with `extra` code after it starts. */
function server({
  status = 200,
  extra = "",
  onTerm = "server.close(() => process.exit(0));",
} = {}) {
  const file = path.join(dir, `server-${++count}.mjs`);
  writeFileSync(
    file,
    `import http from "node:http";
const server = http.createServer((request, response) => {
  response.writeHead(request.url === "/healthz" ? ${status} : 404).end();
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => { ${onTerm} });
${extra}
`,
  );
  return file;
}

async function run(file, options = {}) {
  const port = await freePort();
  return boot({
    file,
    env: { PORT: String(port), ...options.env },
    healthUrl: `http://127.0.0.1:${port}/healthz`,
    readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
    exitTimeoutMs: options.exitTimeoutMs ?? 5_000,
  });
}

describe("boot", () => {
  it("passes when /healthz answers 200 and SIGTERM exits with code 0", async () => {
    const result = await run(server({ extra: 'console.log("listening");' }));
    assert.equal(result.ok, true, result.reason);
    assert.match(result.output, /listening/);
  });

  it("fails at once when the process exits before it is ready, with its output", async () => {
    const file = path.join(dir, "missing-module.mjs");
    writeFileSync(file, 'import "@open-bot/no-such-package";\n');
    const started = Date.now();
    const result = await run(file, { readyTimeoutMs: 30_000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /exited with code 1 before it was ready/);
    assert.match(result.output, /ERR_MODULE_NOT_FOUND/);
    assert.ok(Date.now() - started < 10_000, "waited for the ready timeout after the exit");
  });

  it("fails when /healthz never answers 200 within the timeout, and stops the process", async () => {
    const result = await run(server({ status: 503 }), { readyTimeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not answer 200 within 500 ms/);
  });

  it("fails when the process ignores SIGTERM", async () => {
    const result = await run(server({ onTerm: "" }), { exitTimeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not exit within 500 ms of SIGTERM/);
  });

  it("fails when the process exits with an error code after SIGTERM", async () => {
    const result = await run(server({ onTerm: "process.exit(3);" }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /exited with code 3 after SIGTERM/);
  });

  it("fails on a module error printed by a process that stayed up", async () => {
    const extra = "console.error(\"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\");";
    const result = await run(server({ extra }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /module resolution error/);
  });

  it("passes the process only the given environment", async () => {
    process.env.BOOT_ARTIFACTS_TEST_LEAK = "inherited";
    try {
      const extra =
        'if (process.env.BOOT_ARTIFACTS_TEST_LEAK || process.env.ONLY !== "given") process.exit(9);';
      const result = await run(server({ extra }), { env: { ONLY: "given" } });
      assert.equal(result.ok, true, result.reason);
    } finally {
      delete process.env.BOOT_ARTIFACTS_TEST_LEAK;
    }
  });
});

describe("artifacts", () => {
  it("points every outside address at nowhere and uses the given database and port", () => {
    for (const artifact of artifacts("/tmp/home")) {
      const env = artifact.env({ port: 4567, databaseUrl: "postgres://test/db" });
      assert.equal(env.DATABASE_URL, "postgres://test/db");
      assert.equal(env.HOME, "/tmp/home");
      assert.equal(env.NODE_ENV, "production");
      for (const [name, value] of Object.entries(env)) {
        if (!/^https?:/.test(value)) continue;
        assert.ok(
          value === NOWHERE || value === "http://127.0.0.1:4567",
          `${artifact.name} ${name} points at ${value}`,
        );
      }
    }
  });

  // Every *_URL variable an env module reads must be set here, or be one that is off when unset.
  const OFF_WHEN_UNSET = new Set(["MEMORY_EMBEDDING_URL", "MEMORY_EXTRACTION_URL"]);
  for (const [name, envModule] of [
    ["worker", "apps/worker/src/env.ts"],
    ["pages", "apps/pages/src/env.ts"],
  ]) {
    it(`sets every address ${envModule} reads`, () => {
      const source = readFileSync(path.join(root, envModule), "utf8");
      const names = [...source.matchAll(/^\s+([A-Z][A-Z0-9_]*_URL):/gm)].map((match) => match[1]);
      assert.ok(names.length > 1, `no *_URL variables found in ${envModule}`);
      const artifact = artifacts("/tmp/home").find((entry) => entry.name === name);
      const env = artifact.env({ port: 1, databaseUrl: "postgres://test/db" });
      for (const variable of names) {
        if (OFF_WHEN_UNSET.has(variable)) assert.equal(env[variable], undefined, variable);
        else assert.ok(env[variable], `${name}: ${variable} is not set`);
      }
    });
  }
});
