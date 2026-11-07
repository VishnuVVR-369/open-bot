import { NextResponse } from "next/server";
import { lastScreenFrames } from "@/lib/server/api/screens";
import { authed } from "@/lib/server/route";

/** Each screen's last captured frame, by screen id: `{ artifactId, at }`. */
export const GET = authed(async () => NextResponse.json(await lastScreenFrames()));
