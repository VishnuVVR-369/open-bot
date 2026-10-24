import { NextResponse } from "next/server";
import { getRunView } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/runs/[runId]">) => {
    const { runId } = await params;
    const run = await getRunView(runId);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    return NextResponse.json(run);
  },
);
