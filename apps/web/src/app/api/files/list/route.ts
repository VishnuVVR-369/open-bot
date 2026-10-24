import { NextResponse } from "next/server";
import { authed } from "@/lib/server/route";
import { worker } from "@/lib/server/worker";

export const GET = authed(async (request: Request) => {
  const path = new URL(request.url).searchParams.get("path") ?? "/home/bot";
  return NextResponse.json(
    await worker("GET", `/internal/files/list?path=${encodeURIComponent(path)}`),
  );
});
