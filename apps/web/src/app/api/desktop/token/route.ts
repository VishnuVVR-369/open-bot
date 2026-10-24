import { issueToken } from "@open-bot/shared/tokens";
import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/server/env";
import { authed } from "@/lib/server/route";

/** A short-lived token for the browser's VNC connection through the worker. */
export const GET = authed(async () =>
  NextResponse.json({
    url: serverEnv.workerWsUrl,
    token: issueToken("vnc", serverEnv.workerSecret, 60),
  }),
);
