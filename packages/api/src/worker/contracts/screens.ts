import { base, computer, id, ok } from "../base";
import { screenOperationSchema, typeOnScreenSchema } from "@open-bot/domain";
import { z } from "zod";

export const screensContract = {
  wake: computer
    .route({ method: "POST", path: "/internal/screens/{screenId}/wake" })
    .input(z.object({ screenId: id }))
    .output(ok),
  forget: computer
    .route({ method: "POST", path: "/internal/screens/{screenId}/forget" })
    .input(z.object({ screenId: id }))
    .output(ok),
  take: computer
    .route({ method: "POST", path: "/internal/screens/{screenId}/take" })
    .input(z.object({ screenId: id }))
    .output(ok),
  handBack: computer
    .route({ method: "POST", path: "/internal/screens/{screenId}/hand-back" })
    .input(
      z.object({
        screenId: id,
        note: z.string().max(2000).nullable().optional(),
        clearCode: z.boolean().optional(),
      }),
    )
    .output(ok),
  /** The owner is using the screen, so it isn't handed back for being idle. */
  touch: computer
    .route({ method: "POST", path: "/internal/screens/{screenId}/touch" })
    .input(z.object({ screenId: id }))
    .output(ok),
  /** Type a one-time code on the screen a takeover is for. */
  typeCode: computer
    .meta({ secretInput: true })
    .route({ method: "POST", path: "/internal/screens/code" })
    .input(typeOnScreenSchema)
    .output(screenOperationSchema),
};

export const screenOperationsContract = {
  get: base
    .route({ method: "GET", path: "/internal/screen-operations/{operationId}" })
    .input(z.object({ operationId: id }))
    .output(screenOperationSchema.nullable()),
  cancel: base
    .route({ method: "POST", path: "/internal/screen-operations/{operationId}/cancel" })
    .input(z.object({ operationId: id }))
    .output(screenOperationSchema),
};

export const takeoversContract = {
  /** Which screen and site a code typed for this takeover would go to. */
  codeContext: computer
    .route({ method: "GET", path: "/internal/takeover/{takeoverId}/code-context" })
    .input(z.object({ takeoverId: id }))
    .output(z.object({ screenId: z.string(), site: z.string().nullable() })),
  dismiss: base
    .route({ method: "POST", path: "/internal/takeover/{takeoverId}/dismiss" })
    .input(z.object({ takeoverId: id }))
    .output(ok),
};
