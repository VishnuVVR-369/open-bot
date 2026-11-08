import { z } from "zod";

/** A memory a reply was given, and whether it still says the same now. */
export const memoryRunRefSchema = z.object({
  id: z.string(),
  revision: z.number(),
  /** The memory as the reply saw it, or null when it changed or was forgotten since. */
  content: z.string().nullable(),
  changed: z.boolean(),
  forgotten: z.boolean(),
});
export type MemoryRunRef = z.infer<typeof memoryRunRefSchema>;
