import { DrizzleQueryError } from "drizzle-orm";
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

  it("answer a failed query with the database's error, never its SQL or parameters", async () => {
    const sql = "select * from messages where text = $1";
    for (const [cause, error] of [
      [
        new Error("canceling statement due to statement timeout"),
        "canceling statement due to statement timeout",
      ],
      [undefined, "A database query failed."],
    ] as const) {
      const route = authed(async () => {
        throw new DrizzleQueryError(sql, ["a private phrase"], cause);
      });
      const response = await route(request("GET", null));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error });
    }
  });
});
