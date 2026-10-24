import { NextResponse } from "next/server";
import { getChatData } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(
  async (request: Request, { params }: RouteContext<"/api/chats/[chatId]">) => {
    const { chatId } = await params;
    const before = new URL(request.url).searchParams.get("before") ?? undefined;
    const data = await getChatData(chatId, before);
    if (!data) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    return NextResponse.json(data);
  },
);
