import { NextResponse } from "next/server";
import { MemoryError } from "@open-bot/memory";
import { z } from "zod";
import { memoryMarkdown, type MemoryItem } from "@open-bot/shared";
import { authed } from "@/lib/server/route";
import { memoryReady } from "@/lib/server/memory";
import { pool } from "@/lib/server/db";

export const GET = authed(async (request: Request) => {
  try {
    const params = new URL(request.url).searchParams;
    const memory = await memoryReady();
    const runId = params.get("runId");
    if (runId) {
      z.string().uuid().parse(runId);
      const { rows } = await pool.query<{ refs: { id: string; revision: number }[] }>(
        "select refs from memory_contexts where run_id=$1",
        [runId],
      );
      const refs = rows[0]?.refs ?? [];
      const current = refs.length
        ? await pool.query<{
            id: string;
            content: string;
            revision: number;
            bot_id: string | null;
            kind: MemoryItem["kind"];
            state: string;
          }>(
            "select id,content,revision,bot_id,kind,state from memory_items where id=any($1::uuid[])",
            [refs.map((ref) => ref.id)],
          )
        : { rows: [] };
      return NextResponse.json(
        refs.map((ref) => {
          const item = current.rows.find((i) => i.id === ref.id);
          return {
            id: ref.id,
            revision: ref.revision,
            content:
              item?.state === "active" && item.revision === ref.revision ? item.content : null,
            changed: item?.revision !== ref.revision,
            forgotten: !item || item.state === "deleted",
          };
        }),
      );
    }
    const history = params.get("history");
    if (history) {
      const revisions = await memory.history(history, { kind: "user" });
      const ids = revisions.flatMap((r) => (r.source.runId ? [r.source.runId] : []));
      const sources = ids.length
        ? await pool.query<{ id: string; chat_id: string }>(
            "select id,chat_id from runs where id=any($1::uuid[])",
            [ids],
          )
        : { rows: [] };
      return NextResponse.json(
        revisions.map((r) => ({
          ...r,
          source: {
            ...r.source,
            chatId: sources.rows.find((s) => s.id === r.source.runId)?.chat_id,
          },
        })),
      );
    }
    const botId = params.get("botId") || null;
    const items = await memory.list(
      {
        botId,
        candidates: true,
        includeExpired: true,
        limit: params.get("download") === "1" ? 10001 : 200,
        query: params.get("q") ?? "",
      },
      { kind: "user" },
    );
    if (params.get("download") === "1" && items.length > 10000)
      throw new MemoryError(413, "Export is limited to 10,000 memories. Export a narrower scope.");
    if (params.get("download") === "1")
      return new Response(memoryMarkdown(items.filter((i) => i.state === "active")), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="memory.md"',
          "cache-control": "no-store",
        },
      });
    return NextResponse.json(items);
  } catch (error) {
    if (error instanceof MemoryError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "Invalid memory request." }, { status: 400 });
    throw error;
  }
});
