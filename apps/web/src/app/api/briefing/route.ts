import { NextResponse } from "next/server";
import { listFinishedSince } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(async (request: Request) => {
  const since = Number(new URL(request.url).searchParams.get("since"));
  if (!Number.isFinite(since) || since <= 0)
    return NextResponse.json({ error: "Pass since, in milliseconds." }, { status: 400 });
  return NextResponse.json(await listFinishedSince(new Date(since)));
});
