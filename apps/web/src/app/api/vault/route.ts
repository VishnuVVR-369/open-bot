import { NextResponse } from "next/server";
import { listVaultItems } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";

export const GET = authed(async () => NextResponse.json(await listVaultItems()));
