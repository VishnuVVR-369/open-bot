import { LEGACY_DESKTOP_AGENT, issueToken } from "@open-bot/shared/tokens";
import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/server/env";
import { authed } from "@/lib/server/route";

/**
 * The desktop app asks for this with its signed-in session, then opens the egress tunnel.
 * `?device=<id>&name=<name>` names the install; older apps send neither and get the legacy identity.
 */
export const GET = authed(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const id = params.get("device")?.trim() ?? "";
  const name = params.get("name")?.trim().slice(0, 80) || "Mac";
  const agent = /^[\w-]{8,64}$/.test(id)
    ? { kind: "desktop" as const, id, name }
    : LEGACY_DESKTOP_AGENT;
  return NextResponse.json({
    url: `${serverEnv.workerWsUrl}/egress/agent`,
    token: issueToken("egress", serverEnv.workerSecret, 120, { agent }),
  });
});
