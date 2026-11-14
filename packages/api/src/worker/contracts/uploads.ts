import { base, id } from "../base";
import { z } from "zod";
import { uploadViewSchema } from "../../views";

export const uploadsContract = {
  /**
   * How an upload went. The upload itself is `PUT /internal/uploads/{uploadId}` with the raw
   * bytes, outside this contract, so a large file streams through without being buffered.
   */
  status: base
    .route({ method: "GET", path: "/internal/uploads/{uploadId}" })
    .input(z.object({ uploadId: id }))
    .output(uploadViewSchema),
};
