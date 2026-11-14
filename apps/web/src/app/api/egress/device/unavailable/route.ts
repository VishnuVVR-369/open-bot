import { unavailableReasonSchema } from "@open-bot/domain";
import { NextResponse } from "next/server";
import { z } from "zod";
import { deviceRoute } from "@/features/settings/server";
import { worker } from "@/lib/server/worker";

/** The phone was woken but can't carry traffic right now (mobile data, battery, its cap...). */
export const POST = deviceRoute(async (device, request) => {
  const { reason, seq } = z
    .object({
      reason: unavailableReasonSchema,
      /** Numbers the phone's reports, so the worker can drop one that arrives late. */
      seq: z.number().int().nonnegative().optional(),
    })
    .parse(await request.json().catch(() => null));
  await worker.egress.deviceUnavailable({
    deviceId: device.id,
    reason,
    generation: device.generation,
    ...(seq === undefined ? {} : { seq }),
  });
  return NextResponse.json({ ok: true });
});
