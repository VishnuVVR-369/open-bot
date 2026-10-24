import { NextResponse } from "next/server";
import { listTasks } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(async () => NextResponse.json(await listTasks()));
