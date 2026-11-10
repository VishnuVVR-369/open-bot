import { beforeEach, describe, expect, it, vi } from "vitest";

const archived = vi.hoisted(() => [] as string[]);

// The real contract and RPC handler, with one write that records what it was asked to do.
vi.mock("@/lib/server/api/router", async () => {
  const { contract } = await import("@open-bot/api");
  const { implement } = await import("@orpc/server");
  const os = implement(contract);
  return {
    router: {
      chats: {
        archive: os.chats.archive.handler(({ input }) => {
          archived.push(input.chatId);
          return { ok: true as const };
        }),
      },
    },
  };
});
vi.mock("@/lib/server/auth-config", () => ({ TRUSTED_ORIGINS: ["https://app.test"] }));

const chatId = "39559277-e46c-466a-89c7-23864aa758a7";
const url = "https://app.test/api/rpc/chats/archive";

function post(origin: string | null): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      host: "app.test",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ json: { chatId } }),
  });
}

describe("the API route", () => {
  beforeEach(() => {
    archived.length = 0;
  });

  it("never runs a write for a GET, which any site can send with your cookies", async () => {
    const { GET } = await import("./route");
    const data = encodeURIComponent(JSON.stringify({ json: { chatId } }));
    const response = await GET(
      new Request(`${url}?data=${data}`, { headers: { host: "app.test" } }),
    );
    expect(response.status).toBe(405);
    expect(archived).toEqual([]);
  });

  it("refuses a write sent from another site's page", async () => {
    const { POST } = await import("./route");
    const response = await POST(post("https://evil.test"));
    expect(response.status).toBe(403);
    expect(archived).toEqual([]);
  });

  it("runs writes from the app's own pages and from the phone, which sends no Origin", async () => {
    const { POST } = await import("./route");
    expect((await POST(post("https://app.test"))).status).toBe(200);
    expect((await POST(post(null))).status).toBe(200);
    expect(archived).toEqual([chatId, chatId]);
  });
});
