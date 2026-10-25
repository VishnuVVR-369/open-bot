import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const database = process.env.MEMORY_TEST_DATABASE_URL;
if (!database || !/^openbot_memory_test(?:_[a-z0-9]+)?$/.test(new URL(database).pathname.slice(1)))
  throw new Error("An isolated memory test database is required.");
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const address = portServer.address();
if (!address || typeof address === "string") throw new Error("No smoke-test port.");
const port = address.port;
await new Promise((resolve) => portServer.close(resolve));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../apps/worker/dist/worker.mjs", import.meta.url))],
  {
    env: {
      ...process.env,
      DATABASE_URL: database,
      WORKER_PORT: String(port),
      WORKER_SECRET: "memory-worker-smoke-secret",
      BOTD_URL: "http://127.0.0.1:49997",
      HOST_CODEX_AUTH_FILE: "/tmp/openbot-memory-no-auth-file",
      OPENAI_API_BASE_URL: "http://127.0.0.1:49997",
      MEMORY_EMBEDDING_URL: "",
      MEMORY_EXTRACTION_URL: "",
      MEMORY_AI_API_KEY: "",
      MEMORY_AI_DAILY_REQUEST_LIMIT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-16000);
  });
const exited = new Promise((resolve) => child.once("exit", resolve));
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Built worker exited before startup: ${output}`);
    const response = await fetch(`http://127.0.0.1:${port}/internal/status`, {
      headers: { "x-worker-secret": "memory-worker-smoke-secret" },
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    if (response?.ok) {
      const status = await response.json();
      if (status.computer && status.codex) {
        ready = true;
        break;
      }
    }
    await delay(100);
  }
  if (!ready) throw new Error(`Built worker did not become ready: ${output}`);
  console.log("Built worker startup and authenticated status endpoint passed.");
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
