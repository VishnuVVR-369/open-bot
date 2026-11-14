import { z } from "zod";
import {
  automationRunViewSchema,
  scheduleInputSchema,
  scheduleViewSchema,
  triggerInputSchema,
  triggerViewSchema,
} from "../automations";
import { base, id, ok } from "../base";
import { triggerCheckSchema } from "../worker/views";

export const schedulesContract = {
  list: base.output(z.array(scheduleViewSchema)),
  /** A schedule's latest runs, newest first. */
  runs: base.input(z.object({ scheduleId: id })).output(z.array(automationRunViewSchema)),
  create: base.input(scheduleInputSchema).output(z.object({ id: z.string() })),
  update: base
    .input(scheduleInputSchema.extend({ scheduleId: id }))
    .output(z.object({ id: z.string() })),
  setEnabled: base.input(z.object({ scheduleId: id, enabled: z.boolean() })).output(ok),
  remove: base.input(z.object({ scheduleId: id })).output(ok),
  /** Run it now, without changing when it runs next. */
  runNow: base.input(z.object({ scheduleId: id })).output(ok),
  /**
   * A teammate's daily check-in, on or off: every morning it looks over its area and tells you
   * only what needs you. Turning it on resumes a paused one rather than adding another.
   */
  setCheckIn: base.input(z.object({ teammateId: id, on: z.boolean() })).output(ok),
};

export const triggersContract = {
  /** Page watches, webhooks, and Gmail and Calendar triggers. */
  list: base.output(z.array(triggerViewSchema)),
  /** A trigger's latest runs, newest first. */
  runs: base.input(z.object({ triggerId: id })).output(z.array(automationRunViewSchema)),
  create: base
    .input(triggerInputSchema)
    .output(z.object({ id: z.string(), hookPath: z.string().nullable() })),
  update: base
    .input(triggerInputSchema.extend({ triggerId: id }))
    .output(z.object({ id: z.string() })),
  setEnabled: base.input(z.object({ triggerId: id, enabled: z.boolean() })).output(ok),
  remove: base.input(z.object({ triggerId: id })).output(ok),
  /** Look at the watched page, mail or calendar now. */
  check: base.input(z.object({ triggerId: id })).output(triggerCheckSchema),
  /** Give a webhook a new URL. The old one stops working. */
  rotateToken: base.input(z.object({ triggerId: id })).output(z.object({ token: z.string() })),
  /** Call a webhook with a sample request, as a service would. */
  test: base.input(z.object({ triggerId: id })).output(z.object({ runId: z.string() })),
};
