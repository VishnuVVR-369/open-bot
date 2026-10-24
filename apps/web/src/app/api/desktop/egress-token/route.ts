import { issueToken } from "@open-bot/shared/tokens";
import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/server/env";
import { authed } from "@/lib/server/route";

/** The desktop app asks for this with its signed-in session, then opens the egress tunnel. */
export const GET = authed(async () =>
  NextResponse.json({
    url: `${serverEnv.workerWsUrl}/egress/agent`,
    token: issueToken("egress", serverEnv.workerSecret, 120),
  }),
);
