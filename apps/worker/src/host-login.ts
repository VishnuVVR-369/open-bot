import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { CodexClient } from "@open-bot/agent";
import { errorMessage, type Logger } from "./logger";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The Codex CLI on this Mac didn't start");
}

/**
 * Development only: ask this Mac's own Codex to refresh its ChatGPT login.
 *
 * The computer borrows the Mac's login read-only and must never refresh it itself, because a
 * refresh rotates the refresh token and would sign the Mac's Codex out. Instead, a short-lived
 * Codex app-server on the Mac refreshes its own login exactly as it does when you use Codex,
 * and the worker then reads the new access token from the same file.
 */
export async function refreshHostLogin(
  authFile: string,
  codexBin: string,
  log: Logger,
): Promise<void> {
  const port = await freePort();
  const child = spawn(codexBin, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    env: { ...process.env, CODEX_HOME: path.dirname(authFile) },
    stdio: "ignore",
  });
  const exited = new Promise<never>((_, reject) =>
    child.once("exit", (code) => reject(new Error(`The Codex CLI on this Mac exited (${code})`))),
  );
  try {
    await Promise.race([waitForReady(`http://127.0.0.1:${port}/readyz`, 20_000), exited]);
    const client = await CodexClient.connect(`ws://127.0.0.1:${port}`, async () => {
      throw new Error("Not supported");
    });
    try {
      const { account } = await client.request("account/read", { refreshToken: true });
      if (account?.type !== "chatgpt")
        throw new Error("This Mac's Codex isn't signed in to ChatGPT");
      log.info("refreshed this Mac's Codex login");
    } finally {
      client.close();
    }
  } catch (error) {
    log.warn("could not refresh this Mac's Codex login", { error: errorMessage(error) });
    throw error;
  } finally {
    child.kill("SIGTERM");
  }
}
