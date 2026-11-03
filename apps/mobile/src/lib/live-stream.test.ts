import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveStream, type LiveStream, type LiveStreamOptions } from "./live-stream";

type Server = (url: string) => { status: number; chunks?: string[]; hang?: boolean };

function body(chunks: string[], hang: boolean, signal: AbortSignal) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hang) controller.close();
      signal.addEventListener("abort", () => controller.error(new Error("aborted")));
    },
  });
}

function setup(server: Server, overrides: Partial<LiveStreamOptions> = {}) {
  const urls: string[] = [];
  const seen = { ready: 0, app: [] as unknown[], run: [] as number[], connected: [] as boolean[] };
  const unauthorized = vi.fn();
  const stream = createLiveStream({
    appUrl: "https://bot.test",
    headers: async () => ({ cookie: "session=1" }),
    fetch: async (url, init) => {
      urls.push(url);
      expect(init.headers.cookie).toBe("session=1");
      const reply = server(url);
      return {
        ok: reply.status === 200,
        status: reply.status,
        body: body(reply.chunks ?? [], reply.hang ?? false, init.signal),
      };
    },
    onReady: () => (seen.ready += 1),
    onApp: (event) => seen.app.push(event),
    onRun: (event) => seen.run.push(event.id),
    onConnected: (value) => seen.connected.push(value),
    onUnauthorized: unauthorized,
    backoffMs: { initial: 5, max: 20 },
    ...overrides,
  });
  return { stream, urls, seen, unauthorized };
}

const run = (id: number) =>
  `event: run\ndata: ${JSON.stringify({ id, runId: "r", payload: {} })}\n\n`;
const ready = 'event: ready\ndata: {"cursor":0}\n\n';

let current: LiveStream | null = null;
afterEach(() => current?.close());

describe("the live stream", () => {
  it("resumes a chat after the last event it saw, and refreshes on every reconnect", async () => {
    let connection = 0;
    const { stream, urls, seen } = setup(() => {
      connection += 1;
      // The first connection drops after two events; the server replays one of them.
      return connection === 1
        ? { status: 200, chunks: [ready, run(6), run(7)] }
        : {
            status: 200,
            chunks: [ready, run(7), run(8), 'event: app\ndata: {"type":"chats"}\n\n'],
            hang: true,
          };
    });
    current = stream;
    stream.watch({ chatId: "c1", cursor: 5 });
    await vi.waitFor(() => expect(seen.run).toEqual([6, 7, 8]));
    expect(urls[0]).toBe("https://bot.test/api/stream?chat=c1&after=5");
    expect(urls[1]).toBe("https://bot.test/api/stream?chat=c1&after=7");
    expect(seen.ready).toBe(2);
    expect(seen.app).toEqual([{ type: "chats" }]);
    expect(seen.connected).toEqual([true, false, true]);
    expect(stream.cursorOf("c1")).toBe(8);
  });

  it("reconnects when the server goes quiet past its heartbeat", async () => {
    let connection = 0;
    const { stream, seen } = setup(
      () => {
        connection += 1;
        return { status: 200, chunks: [ready], hang: true };
      },
      { stallMs: 30 },
    );
    current = stream;
    stream.watch(null);
    await vi.waitFor(() => expect(connection).toBeGreaterThanOrEqual(3));
    expect(seen.ready).toBeGreaterThanOrEqual(3);
  });

  it("stops when the session is gone", async () => {
    const { stream, urls, unauthorized } = setup(() => ({ status: 401 }));
    current = stream;
    stream.watch(null);
    await vi.waitFor(() => expect(unauthorized).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(urls).toHaveLength(1);
  });

  it("switches chats without mixing their events", async () => {
    const { stream, urls, seen } = setup((url) =>
      url.includes("chat=c2")
        ? { status: 200, chunks: [ready, run(3)], hang: true }
        : { status: 200, chunks: [ready, run(9)], hang: true },
    );
    current = stream;
    stream.watch({ chatId: "c1", cursor: 0 });
    await vi.waitFor(() => expect(seen.run).toEqual([9]));
    stream.watch({ chatId: "c2", cursor: 2 });
    await vi.waitFor(() => expect(seen.run).toEqual([9, 3]));
    expect(urls.at(-1)).toBe("https://bot.test/api/stream?chat=c2&after=2");
    expect(stream.cursorOf("c1")).toBe(9);
  });

  it("resumes from the latest event after the foreground replaces the connection", async () => {
    const cursors = new Map<string, number>();
    const first = setup(() => ({ status: 200, chunks: [ready, run(9)], hang: true }), {
      cursors,
    });
    current = first.stream;
    first.stream.watch({ chatId: "c1", cursor: 5 });
    await vi.waitFor(() => expect(first.seen.run).toEqual([9]));
    first.stream.close();

    const next = setup(() => ({ status: 200, chunks: [ready, run(10)], hang: true }), {
      cursors,
    });
    current = next.stream;
    // The screen's last snapshot predates the live events received before backgrounding.
    next.stream.watch({ chatId: "c1", cursor: 5 });
    await vi.waitFor(() => expect(next.seen.run).toEqual([10]));
    expect(next.urls[0]).toBe("https://bot.test/api/stream?chat=c1&after=9");
  });
});
