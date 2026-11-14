import { NextResponse } from "next/server";
import { MemoryError } from "@open-bot/memory";
import { memoryMarkdown } from "@open-bot/domain";
import { z } from "zod";
import { authed } from "@/lib/server/route";
import { listMemories, MEMORY_EXPORT_LIMIT } from "@/features/memory/server";

const botIdSchema = z.string().uuid().nullable();

/**
 * Memories as a Markdown file: one teammate's with `?botId=`, or everyone's. Reading memory in the
 * app goes through the API (`memory.list`); this is only the download.
 */
export const GET = authed(async (request: Request) => {
  const botId = botIdSchema.safeParse(new URL(request.url).searchParams.get("botId") || null);
  if (!botId.success)
    return NextResponse.json({ error: "Invalid memory request." }, { status: 400 });
  try {
    const items = await listMemories(
      { teammateId: botId.data, query: "" },
      MEMORY_EXPORT_LIMIT + 1,
    );
    if (items.length > MEMORY_EXPORT_LIMIT)
      throw new MemoryError(413, "Export is limited to 10,000 memories. Export a narrower scope.");
    return new Response(memoryMarkdown(items.filter((i) => i.state === "active")), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": 'attachment; filename="memory.md"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof MemoryError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
