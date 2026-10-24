import { NextResponse } from "next/server";
import { authed } from "@/lib/server/route";
import { worker } from "@/lib/server/worker";

export const GET = authed(async () =>
  NextResponse.json(await worker<{ rateLimits: unknown }>("GET", "/internal/codex/rate-limits")),
);
