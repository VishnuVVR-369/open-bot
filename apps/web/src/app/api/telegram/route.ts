import { NextResponse } from "next/server";
import { authed } from "@/lib/server/route";
import { worker } from "@/lib/server/worker";
import type { TelegramStatusView } from "@/lib/types";

export const GET = authed(async () =>
  NextResponse.json(await worker<TelegramStatusView>("GET", "/internal/telegram")),
);
