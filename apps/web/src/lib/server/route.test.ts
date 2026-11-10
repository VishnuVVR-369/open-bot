import { describe, expect, it, vi } from "vitest";
import { authed } from "./route";

vi.mock("./session", () => ({ sessionOrNull: async () => ({ user: { id: "owner" } }) }));
vi.mock("./auth-config", () => ({ TRUSTED_ORIGINS: ["https://app.test"] }));
vi.mock("./worker", () => ({ WorkerError: class extends Error {} }));

function request(method: string, origin: string | null): Request {
  return new Request("https://app.test/api/uploads/1", {
    method,
    headers: { host: "app.test", ...(origin ? { origin } : {}) },
  });
}

describe("authed routes", () => {
  it("refuse a write from another site's page before running it", async () => {
    const handler = vi.fn(async () => new Response("done"));
    const response = await authed(handler)(request("PUT", "https://evil.test"));
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("run writes from the app's pages and the phone, and reads from anywhere", async () => {
    const handler = vi.fn(async () => new Response("done"));
    const route = authed(handler);
    expect((await route(request("PUT", "https://app.test"))).status).toBe(200);
    expect((await route(request("PUT", null))).status).toBe(200);
    expect((await route(request("GET", "https://evil.test"))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
