import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { signPageVersion } from "@open-bot/domain/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPagesHandler } from "./server";

const secret = "test-pages-secret-0123456789-abcdefgh";
const id = "2b148551-94eb-4df1-90ef-231f7386f89a";
const html = "<!doctype html><html><head><title>T</title></head><body><h1>Hello</h1></body></html>";
const libDir = dirname(createRequire(import.meta.url).resolve("@open-bot/page-kit/lib/runtime.js"));

describe("pages service", () => {
  let server: http.Server;
  let base: string;
  const loadVersion = vi.fn(async (versionId: string) =>
    versionId === id ? { html, sha256: "ab".repeat(32) } : null,
  );

  beforeAll(async () => {
    const handler = createPagesHandler({
      origin: "https://pages.example.app",
      appOrigins: ["https://app.example.app"],
      secret,
      libDir,
      loadVersion,
      log: () => {},
    });
    server = http.createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("serves a version with a good key, sandboxed, with the runtime first", async () => {
    const response = await fetch(`${base}/v/${id}?k=${signPageVersion(id, secret)}&theme=dark`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^sandbox allow-scripts/);
    expect(csp).toContain("frame-ancestors https://app.example.app");
    expect(csp).toContain("script-src 'unsafe-inline' https://pages.example.app/lib/");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, max-age=600");
    expect(await response.text()).toBe(
      html.replace(
        "<head>",
        '<head><script src="https://pages.example.app/lib/runtime.js"></script>',
      ),
    );
  });

  it("refuses a missing, wrong or expired key without loading anything", async () => {
    loadVersion.mockClear();
    const expired = signPageVersion(id, secret, 60, Date.now() - 120_000);
    for (const key of ["", "nope", signPageVersion(id, `${secret}x`), expired]) {
      const response = await fetch(`${base}/v/${id}?k=${encodeURIComponent(key)}`);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await response.text()).toContain("This link has expired");
    }
    expect(loadVersion).not.toHaveBeenCalled();
  });

  it("says so when the page was deleted", async () => {
    const gone = "3637f7d1-3434-4882-a05b-3c14f29c2001";
    const response = await fetch(`${base}/v/${gone}?k=${signPageVersion(gone, secret)}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This page is gone");
  });

  it("serves the shared libraries to any page, and nothing outside them", async () => {
    const runtime = await fetch(`${base}/lib/runtime.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("content-type")).toContain("javascript");
    expect(runtime.headers.get("access-control-allow-origin")).toBe("*");
    expect(runtime.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    for (const path of ["/lib/../package.json", "/lib/%2e%2e/manifest.json", "/lib/nope.js"])
      expect((await fetch(`${base}${path}`)).status).toBe(404);
  });

  it("answers only reads", async () => {
    const response = await fetch(`${base}/v/${id}?k=${signPageVersion(id, secret)}`, {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
  });
});
