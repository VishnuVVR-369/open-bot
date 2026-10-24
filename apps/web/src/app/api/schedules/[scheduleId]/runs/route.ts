import { NextResponse } from "next/server";
import { listAutomationRuns } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/schedules/[scheduleId]/runs">) => {
    const { scheduleId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(scheduleId)) return NextResponse.json([]);
    return NextResponse.json(await listAutomationRuns({ scheduleId }));
  },
);
