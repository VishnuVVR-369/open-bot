import { NextResponse } from "next/server";
import { getSpending } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

/** A teammate's monthly budget, what it spent, and its purchases. */
export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/bots/[botId]/spending">) => {
    const { botId } = await params;
    const spending = /^[0-9a-f-]{36}$/i.test(botId) ? await getSpending(botId) : null;
    if (!spending) return NextResponse.json({ error: "No such teammate." }, { status: 404 });
    return NextResponse.json(spending);
  },
);
