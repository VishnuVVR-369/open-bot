import { os } from "../../core/rpc";
import type { UploadService } from "./service";

import { rpcError } from "../../rpc/errors";

/** The uploads procedures in the worker's internal API. */
export function uploadsRoutes(uploads: UploadService) {
  return {
    status: os.uploads.status.handler(async ({ input }) => {
      const upload = await uploads.status(input.uploadId);
      if (!upload) throw rpcError(404, "That upload isn't here.");
      return upload;
    }),
  };
}
