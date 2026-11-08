import { runEvents } from "@open-bot/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { DEPLOYMENT_ID } from "@/lib/deployment";
import { db } from "@/lib/server/db";
import { realtime } from "@/lib/server/realtime";
import { sessionOrNull } from "@/lib/server/session";
import type { StreamRunEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 20_000;
/** How soon a tab reconnects after its stream ends, in milliseconds. */
const RETRY_MS = 1_000;

/**
 * A stopping server would hold a new stream until it is killed. This one ends at once and closes
 * its connection, so the browser reconnects on a new one, which reaches the new deploy.
 */
function turnedAway() {
  return new Response(`retry: ${RETRY_MS}\n\n`, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "close",
    },
  });
}

/**
 * Server-sent events for one browser tab:
 * - `app`: something app-wide changed (bots, computer, approvals, notifications...).
 * - `ready`: connected, with the deploy that serves it.
 * - `run`: a new run event in the chat the tab is looking at, in order, starting after `after`.
 */
export async function GET(request: Request) {
  const session = await sessionOrNull();
  if (!session) return new Response("Sign in first.", { status: 401 });
  if (realtime.stopping) return turnedAway();

  const url = new URL(request.url);
  const chatId = url.searchParams.get("chat");
  let cursor = Number(url.searchParams.get("after") ?? 0) || 0;
  await realtime.ensure();
  // The server may have started stopping while this waited for Postgres.
  if (realtime.stopping) return turnedAway();

  const encoder = new TextEncoder();
  let closed = false;
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Fetch and send everything after the cursor. Serialized, so events are never sent twice or out of order.
      let pending: Promise<void> = Promise.resolve();
      const flushChat = () => {
        if (!chatId) return;
        pending = pending
          .then(async () => {
            if (closed) return;
            for (;;) {
              const rows = await db
                .select({ id: runEvents.id, runId: runEvents.runId, payload: runEvents.payload })
                .from(runEvents)
                .where(and(eq(runEvents.chatId, chatId), gt(runEvents.id, cursor)))
                .orderBy(asc(runEvents.id))
                .limit(500);
              for (const row of rows) {
                cursor = row.id;
                send("run", row satisfies StreamRunEvent);
              }
              if (rows.length < 500) break;
            }
          })
          .catch(() => {});
      };

      const onChat = (id: string) => {
        if (id === chatId) flushChat();
      };
      const onApp = (payload: string) => {
        try {
          send("app", JSON.parse(payload));
        } catch {
          // Ignore malformed payloads.
        }
      };
      const onShutdown = () => {
        if (!closed) controller.enqueue(encoder.encode(`retry: ${RETRY_MS}\n\n`));
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      realtime.on("chat", onChat);
      realtime.on("app", onApp);
      realtime.on("shutdown", onShutdown);
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, HEARTBEAT_MS);

      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        realtime.off("chat", onChat);
        realtime.off("app", onApp);
        realtime.off("shutdown", onShutdown);
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });

      // Which deploy is serving, so a tab running older code reloads.
      send("ready", { cursor, deployment: DEPLOYMENT_ID });
      // Catch up on anything that happened between the page load and this connection.
      flushChat();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
