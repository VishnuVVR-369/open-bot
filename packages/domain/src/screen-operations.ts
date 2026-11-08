import { z } from "zod";
import type { LeaseHolder } from "./computer";

export const screenOperationStatusSchema = z.enum([
  "received",
  "typing",
  "typed",
  "verifying",
  "safe",
  "handed_back",
  "cancelled",
  "failed",
  "needs_owner",
  "unknown",
]);
export type ScreenOperationStatus = z.infer<typeof screenOperationStatusSchema>;

/** Codes travel only in this request, never in a stored operation or its result. */
export const typeOnScreenSchema = z.object({
  takeoverId: z.string().uuid(),
  operationId: z.string().uuid(),
  expectedSite: z.string().min(1).max(253),
  pressEnter: z.boolean(),
  text: z.string().regex(/^\d{4,8}$/, "Enter a one-time code with 4 to 8 digits."),
});
export type TypeOnScreen = z.infer<typeof typeOnScreenSchema>;

export const screenOperationSchema = z.object({
  id: z.string().uuid(),
  takeoverId: z.string().nullable(),
  screenId: z.string().nullable(),
  status: screenOperationStatusSchema,
  reason: z.string().nullable(),
});
export type ScreenOperation = z.infer<typeof screenOperationSchema>;

/**
 * What botd reports after typing a code. `previous` is who held the screen before code entry
 * took it, so an interrupted run can continue after the hand-back.
 */
export interface CodeEntryResult {
  status: "safe" | "needs_owner" | "failed" | "unknown";
  reason: string | null;
  previous?: LeaseHolder;
}
