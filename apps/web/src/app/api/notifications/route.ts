import { NextResponse } from "next/server";
import { listNotifications } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(async () => NextResponse.json(await listNotifications()));
