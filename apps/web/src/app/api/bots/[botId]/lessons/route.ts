import { NextResponse } from "next/server";
import { listLessons } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/bots/[botId]/lessons">) => {
    const { botId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(botId)) return NextResponse.json([]);
    return NextResponse.json(await listLessons(botId));
  },
);
