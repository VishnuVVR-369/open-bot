import { base, id, ok } from "../base";
import { z } from "zod";
import {
  runNowAnswerSchema,
  scheduleInputSchema,
  schedulePatchSchema,
  triggerInputSchema,
  triggerPatchSchema,
} from "../../automations";
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
  /** Change only the name or timing given; 404 when it was deleted. */
  patch: base
    .route({ method: "POST", path: "/internal/schedules/{scheduleId}/patch" })
    .input(schedulePatchSchema)
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
  /**
   * Run it now, without changing when it runs next; a `runId` already used starts nothing more.
   * `started` is false when an earlier ask with the same `runId` started the run; an id another
   * run has is 409, and so is a schedule whose teammate is archived.
   */
  runNow: base
    .route({ method: "POST", path: "/internal/schedules/{scheduleId}/run" })
    .input(z.object({ scheduleId: id, runId: id.optional() }))
    .output(runNowAnswerSchema),
  /** The teammate's daily check-in, on or off; see `schedulesContract.setCheckIn` in the API. */
  setCheckIn: base
    .route({ method: "POST", path: "/internal/teammates/{teammateId}/check-in" })
    .input(z.object({ teammateId: id, on: z.boolean() }))
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
  /** Change only the name, interval or lead time given; 404 when it was deleted. */
  patch: base
    .route({ method: "POST", path: "/internal/triggers/{triggerId}/patch" })
    .input(triggerPatchSchema)
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
