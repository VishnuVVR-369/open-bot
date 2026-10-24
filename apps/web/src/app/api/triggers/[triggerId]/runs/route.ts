import { NextResponse } from "next/server";
import { listAutomationRuns } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/triggers/[triggerId]/runs">) => {
    const { triggerId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(triggerId)) return NextResponse.json([]);
    return NextResponse.json(await listAutomationRuns({ triggerId }));
  },
);
