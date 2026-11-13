import { z } from "zod";
import { base, id, ok } from "../base";
import {
  screenFrameSchema,
  screenViewSchema,
  screenOperationSchema,
  typeOnScreenSchema,
} from "../screens";

export const screensContract = {
  list: base.output(z.array(screenViewSchema)),
  /** Each screen's last captured frame, by screen id, to show while the computer sleeps. */
  frames: base.output(z.record(z.string(), screenFrameSchema)),
  takeOver: base.input(z.object({ screenId: id })).output(ok),
  handBack: base
    .input(
      z.object({
        screenId: id,
        note: z.string().max(2000).nullable(),
        clearCode: z.boolean().optional(),
      }),
    )
    .output(ok),
  wake: base.input(z.object({ screenId: id })).output(ok),
  activity: base.input(z.object({ screenId: id })).output(ok),
};

export const takeoversContract = {
  dismiss: base.input(z.object({ takeoverId: id })).output(ok),
  codeContext: base
    .input(z.object({ takeoverId: id }))
    .output(z.object({ screenId: id, site: z.string().nullable() })),
};

export const screenOperationsContract = {
  type: base.input(typeOnScreenSchema).output(screenOperationSchema),
  get: base.input(z.object({ operationId: id })).output(screenOperationSchema.nullable()),
  cancel: base.input(z.object({ operationId: id })).output(screenOperationSchema),
};
