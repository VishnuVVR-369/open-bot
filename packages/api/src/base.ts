import { oc } from "@orpc/contract";
import { z } from "zod";
import { approvalStatusSchema } from "./views";

/** Errors a caller is expected to handle, beyond the common ones (`UNAUTHORIZED`, `BAD_REQUEST`). */
export const API_ERRORS = {
  NOT_FOUND: { status: 404, message: "That's gone." },
  /** A retry reused a client id for a different request. */
  CONFLICT: { status: 409, message: "That id was already used for something else." },
  /** Decided differently somewhere else, or expired. `data.status` says how it ended. */
  ALREADY_DECIDED: {
    status: 409,
    message: "This was already decided.",
    data: z.object({ status: approvalStatusSchema }),
  },
} as const;

/** Every procedure of the API starts here, so they all declare the same errors. */
export const base = oc.errors(API_ERRORS);

export const id = z.string().uuid();

export const ok = z.object({ ok: z.literal(true) });

/** The teammates that may use something, or null for every teammate. */
export const teammateAccessSchema = z
  .array(id)
  .min(1, "Pick at least one teammate, or everyone.")
  .max(500)
  .nullable();
