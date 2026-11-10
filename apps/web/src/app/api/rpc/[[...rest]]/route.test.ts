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

  it("refuses a body over 8 MB without holding it, said or streamed", async () => {
    const { POST } = await import("./route");
    const limit = 8 * 1024 * 1024;
    const said = new Request(url, {
      method: "POST",
      headers: {
        host: "app.test",
        "content-type": "application/json",
        "content-length": String(limit + 1),
      },
      body: "{}",
    });
    expect((await POST(said)).status).toBe(413);

    let sent = 0;
    const streamed = new Request(url, {
      method: "POST",
      headers: { host: "app.test", "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > 4 * limit) return controller.close();
          sent += 1024 * 1024;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      }),
      // @ts-expect-error Node needs it for a streamed body.
      duplex: "half",
    });
    expect((await POST(streamed)).status).toBe(413);
    expect(sent).toBeLessThan(2 * limit);
    expect(archived).toEqual([]);
  });
});
