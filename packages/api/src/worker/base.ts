import { oc } from "@orpc/contract";
import { z } from "zod";

export interface WorkerMeta {
  /**
   * The procedure needs the computer: it is woken first if it is asleep, and kept awake until
   * the procedure finishes. Never set it on a read of status, which must not wake the computer.
   */
  wakesComputer?: boolean;
  /** The input carries a secret, like a one-time code: errors never echo it back. */
  secretInput?: boolean;
}

export const base = oc.$meta<WorkerMeta>({});
/** A procedure that needs the computer awake; see `WorkerMeta.wakesComputer`. */
export const computer = base.meta({ wakesComputer: true });

export const id = z.string().uuid();
export const ok = z.object({ ok: z.literal(true) });
