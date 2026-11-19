import { NextResponse } from "next/server";
import { z } from "zod";
import { authed } from "@/lib/server/route";
import { exportFileName, exportStream } from "@/features/model-logs/server";

const scopeSchema = z.union([
  z.object({ runId: z.uuid() }).strict(),
  z
    .object({
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
]);

/**
 * Model logs as JSONL: every request of one run (`?runId=`), or of a date range (`?from=&to=`,
 * either end open), rebuilt in full, one per line. Streamed as it is read; owner only.
 */
export const GET = authed(async (request: Request) => {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const scope = scopeSchema.safeParse(params);
  if (!scope.success)
    return NextResponse.json({ error: "Export a run, or a range of dates." }, { status: 400 });
  return new Response(exportStream(scope.data), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFileName(scope.data)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
