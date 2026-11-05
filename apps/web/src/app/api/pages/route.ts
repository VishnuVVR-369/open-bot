import { NextResponse } from "next/server";
import { listPages } from "@/lib/server/api/pages";
import { authed } from "@/lib/server/route";

export const GET = authed(async () => NextResponse.json(await listPages()));
