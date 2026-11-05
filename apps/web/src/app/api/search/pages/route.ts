import { NextResponse } from "next/server";
import { searchPages } from "@/lib/server/api/pages";
import { authed } from "@/lib/server/route";

/** Pages whose title, summary or text has the words, newest first. */
export const GET = authed(async (request: Request) => {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json(await searchPages(query.slice(0, 200)));
});
