import { bundleFileName } from "@open-bot/domain";
import { NextResponse } from "next/server";
import { authed } from "@/lib/server/route";
import { worker, WorkerError } from "@/lib/server/worker";

/** The teammate as a file you can keep or import elsewhere. */
export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/bots/[botId]/export">) => {
    const { botId: teammateId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(teammateId))
      return NextResponse.json({ error: "No such teammate." }, { status: 404 });
    try {
      const { slug, bundle } = await worker.teammates.export({ teammateId });
      return new Response(`${JSON.stringify(bundle, null, 2)}\n`, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${bundleFileName(slug)}"`,
        },
      });
    } catch (error) {
      if (error instanceof WorkerError && error.status === 404)
        return NextResponse.json({ error: "No such teammate." }, { status: 404 });
      throw error;
    }
  },
);
