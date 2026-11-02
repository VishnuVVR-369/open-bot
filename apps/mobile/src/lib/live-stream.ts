import { SseParser, type AppStreamEvent, type StreamRunEvent } from "@open-bot/api";

/**
 * The connection to `/api/stream`, kept open while the app is in front: it reconnects with
 * backoff when the network drops, and when the server goes quiet for longer than its heartbeat.
 * Platform-free (fetch and timers are passed in), so it's tested in Node.
 */

export interface LiveStreamOptions {
  appUrl: string;
  /** Headers for each connection, like the session cookie. */
  headers: () => Promise<Record<string, string>>;
  /** A fetch whose response body is a readable stream (`expo/fetch` on the phone). */
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
  /** Connected (again). Anything app-wide may have changed while disconnected. */
  onReady: () => void;
  onApp: (event: AppStreamEvent) => void;
  onRun: (event: StreamRunEvent) => void;
  /** Whether the stream is up, for a "Reconnecting" indicator. */
  onConnected: (connected: boolean) => void;
  /** The session is gone (401): stop, and let the app sign you in again. */
  onUnauthorized: () => void;
  /** No data for this long means the connection is dead (the server sends one every 20 s). */
  stallMs?: number;
  backoffMs?: { initial: number; max: number };
}

export interface LiveStream {
  /** Follow a chat's run events after `cursor`, or only app events (null). Reconnects. */
  watch(target: { chatId: string; cursor: number } | null): void;
  /** The last run event seen for a chat, to resume from. */
  cursorOf(chatId: string): number;
  close(): void;
}

export function createLiveStream(options: LiveStreamOptions): LiveStream {
  const stallMs = options.stallMs ?? 45_000;
  const backoff = options.backoffMs ?? { initial: 1_000, max: 15_000 };
  const cursors = new Map<string, number>();
  let target: { chatId: string } | null = null;
  let closed = false;
  let controller: AbortController | null = null;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = backoff.initial;

  const cursorOf = (chatId: string) => cursors.get(chatId) ?? 0;

  async function connect(current: number) {
    controller = new AbortController();
    const signal = controller.signal;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller?.abort(), stallMs);
    };
    const params = new URLSearchParams();
    if (target) {
      params.set("chat", target.chatId);
      params.set("after", String(cursorOf(target.chatId)));
    }
    let unauthorized = false;
    try {
      resetStall();
      const response = await options.fetch(`${options.appUrl}/api/stream?${params}`, {
        headers: { ...(await options.headers()), accept: "text/event-stream" },
        signal,
      });
      unauthorized = response.status === 401;
      if (unauthorized) throw new Error("signed out");
      if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const chatId = target?.chatId ?? null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done || current !== generation) break;
        resetStall();
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          if (message.event === "ready") {
            delay = backoff.initial;
            options.onConnected(true);
            options.onReady();
          } else if (message.event === "app") {
            options.onApp(JSON.parse(message.data) as AppStreamEvent);
          } else if (message.event === "run" && chatId) {
            const event = JSON.parse(message.data) as StreamRunEvent;
            if (event.id <= cursorOf(chatId)) continue;
            cursors.set(chatId, event.id);
            options.onRun(event);
          }
        }
      }
    } catch {
      // Dropped, refused or stalled: reconnect below.
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    if (current !== generation || closed) return;
    options.onConnected(false);
    if (unauthorized) {
      options.onUnauthorized();
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (current === generation && !closed) void connect(current);
    }, delay);
    delay = Math.min(delay * 2, backoff.max);
  }

  function restart() {
    generation += 1;
    controller?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    delay = backoff.initial;
    if (!closed) void connect(generation);
  }

  return {
    watch(next) {
      if (next) cursors.set(next.chatId, Math.max(next.cursor, cursorOf(next.chatId)));
      target = next ? { chatId: next.chatId } : null;
      restart();
    },
    cursorOf,
    close() {
      closed = true;
      generation += 1;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
