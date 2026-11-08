import type { EgressAgentClaim } from "@open-bot/domain/tokens";
import { z } from "zod";

/** The device an egress token names. A phone's claim must carry its pairing generation. */
export const egressAgentClaimSchema: z.ZodType<EgressAgentClaim> = z.union([
  z.object({
    kind: z.literal("desktop"),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
  }),
  z.object({
    kind: z.literal("phone"),
    id: z.string().uuid(),
    name: z.string().min(1).max(80),
    generation: z.number().int().positive(),
  }),
]);
