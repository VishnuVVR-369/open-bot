import { NextResponse } from "next/server";
import { z } from "zod";
import { deviceRoute } from "@/features/settings/server";
import { worker } from "@/lib/server/worker";

/** FCM gave the phone a new token; the worker wakes the phone with it from now on. */
export const POST = deviceRoute(async (device, request) => {
  const { token } = z
    .object({ token: z.string().min(1).max(4096) })
    .parse(await request.json().catch(() => null));
  if (token !== device.pushToken)
    await worker.egress.devicePushToken({ deviceId: device.id, token });
  return NextResponse.json({ ok: true });
});
