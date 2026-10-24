import { NextResponse } from "next/server";
import { searchMessages } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(async (request: Request) => {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json(await searchMessages(query.slice(0, 200)));
});
