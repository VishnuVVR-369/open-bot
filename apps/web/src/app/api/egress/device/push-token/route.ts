import { egressDevices } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/server/db";
import { deviceRoute } from "@/lib/server/egress-device";
import { worker } from "@/lib/server/worker";

/** FCM gave the phone a new token; the worker wakes the phone with it from now on. */
export const POST = deviceRoute(async (device, request) => {
  const { token } = z
    .object({ token: z.string().min(1).max(4096) })
    .parse(await request.json().catch(() => null));
  if (token !== device.pushToken) {
    await db.update(egressDevices).set({ pushToken: token }).where(eq(egressDevices.id, device.id));
    await worker("POST", "/internal/egress/devices/changed").catch(() => {});
  }
  return NextResponse.json({ ok: true });
});
