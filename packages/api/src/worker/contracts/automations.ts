import { base, id, ok } from "../base";
import { z } from "zod";
import { scheduleInputSchema, triggerInputSchema } from "../../automations";
import { triggerCheckSchema } from "../views";

export const schedulesContract = {
  create: base
    .route({ method: "POST", path: "/internal/schedules" })
    .input(scheduleInputSchema)
    .output(z.object({ id: z.string() })),
  update: base
    .route({ method: "POST", path: "/internal/schedules/{scheduleId}" })
    .input(scheduleInputSchema.extend({ scheduleId: id }))
    .output(z.object({ id: z.string() })),
  setEnabled: base
    .route({ method: "POST", path: "/internal/schedules/{scheduleId}/enabled" })
    .input(z.object({ scheduleId: id, enabled: z.boolean() }))
    .output(ok),
  /** Delete it; one already gone is fine. */
  remove: base
    .route({ method: "POST", path: "/internal/schedules/{scheduleId}/delete" })
    .input(z.object({ scheduleId: id }))
    .output(ok),
  /** Run it now, without changing when it runs next. */
  runNow: base
    .route({ method: "POST", path: "/internal/schedules/{scheduleId}/run" })
    .input(z.object({ scheduleId: id }))
    .output(ok),
};

export const triggersContract = {
  create: base
    .route({ method: "POST", path: "/internal/triggers" })
    .input(triggerInputSchema)
    .output(z.object({ id: z.string(), hookPath: z.string().nullable() })),
  update: base
    .route({ method: "POST", path: "/internal/triggers/{triggerId}" })
    .input(triggerInputSchema.extend({ triggerId: id }))
    .output(z.object({ id: z.string() })),
  setEnabled: base
    .route({ method: "POST", path: "/internal/triggers/{triggerId}/enabled" })
    .input(z.object({ triggerId: id, enabled: z.boolean() }))
    .output(ok),
  remove: base
    .route({ method: "POST", path: "/internal/triggers/{triggerId}/delete" })
    .input(z.object({ triggerId: id }))
    .output(ok),
  /** Look at the watched page, mail or calendar now. */
  check: base
    .route({ method: "POST", path: "/internal/triggers/{triggerId}/check" })
    .input(z.object({ triggerId: id }))
    .output(triggerCheckSchema),
  /** Give a webhook a new URL. The old one stops working. */
  rotateToken: base
    .route({ method: "POST", path: "/internal/triggers/{triggerId}/rotate" })
    .input(z.object({ triggerId: id }))
    .output(z.object({ token: z.string() })),
};

export const hooksContract = {
  /**
   * A service called a webhook. Fails with 404 for an unknown webhook, 409 when it is paused or
   * its teammate is archived, and 429 when it already started too many runs this hour.
   */
  fire: base
    .route({ method: "POST", path: "/internal/hooks/{token}" })
    .input(
      z.object({
        token: z.string(),
        method: z.string().max(10),
        contentType: z.string().max(200),
        body: z.string().max(512 * 1024),
        query: z.string().max(4000),
      }),
    )
    .output(z.object({ runId: z.string() })),
};
