import { z } from "zod";
import { base, id } from "../base";
import { uploadViewSchema } from "../views";

export const uploadsContract = {
  /** How an upload went, to check one whose response was lost before trying it again. */
  status: base.input(z.object({ uploadId: id })).output(uploadViewSchema),
};
