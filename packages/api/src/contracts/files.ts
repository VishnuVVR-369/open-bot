import { z } from "zod";
import { base, ok } from "../base";
import { fileListingSchema } from "../worker/views";

export const filesContract = {
  /**
   * A folder on the computer, inside `/home/bot`. Wakes the computer if it sleeps; fails with
   * `SERVICE_UNAVAILABLE` while it can't be reached.
   */
  list: base.input(z.object({ path: z.string().max(4096) })).output(fileListingSchema),
  /**
   * Delete a file or folder. Refused for folders the system needs, like an active teammate's
   * workspace. Adding a file is `PUT /api/files/upload`, which takes its bytes.
   */
  remove: base.input(z.object({ path: z.string().min(1).max(4096) })).output(ok),
};
