import { computers, egressDevices } from "@open-bot/db";
import { issueToken } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { deviceRoute } from "@/lib/server/egress-device";
import { serverEnv } from "@/lib/server/env";

/**
 * A paired phone asks for this before it opens the egress tunnel. The phone mode in the answer is
 * the server's, which the phone follows over anything it remembers.
 */
export const POST = deviceRoute(async (device) => {
  const [[computer]] = await Promise.all([
    db
      .select({ phoneEgress: computers.phoneEgress })
      .from(computers)
      .where(eq(computers.id, "default")),
    db.update(egressDevices).set({ lastUsedAt: new Date() }).where(eq(egressDevices.id, device.id)),
  ]);
  return NextResponse.json({
    url: `${serverEnv.workerWsUrl}/egress/agent`,
    token: issueToken("egress", serverEnv.workerSecret, 120, {
      agent: { kind: "phone", id: device.id, name: device.name, generation: device.generation },
    }),
    phoneMode: computer?.phoneEgress ?? "fallback",
    generation: device.generation,
  });
});
