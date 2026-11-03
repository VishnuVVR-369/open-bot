import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { File, UploadType } from "expo-file-system";
import { api } from "./api";
import { sessionCookie } from "./auth";
import { APP_URL } from "./config";
import {
  MAX_ATTEMPTS,
  readUploadAnswer,
  retryDelay,
  uploadHeaders,
  uploadUrl,
  type PickedFile,
  type UploadAnswer,
} from "./upload-protocol";

export type { PickedFile };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload a picked file as an attachment, straight from disk, with progress. It keeps one id for
 * every attempt, so a retry after a lost answer never stores the file twice; before sending it
 * again, it asks whether the last attempt made it after all.
 */
export async function uploadAttachment(
  picked: PickedFile,
  options: { onProgress: (fraction: number) => void; signal: AbortSignal },
): Promise<UploadAnswer> {
  if (options.signal.aborted) return { kind: "failed", message: "Cancelled." };
  const uploadId = Crypto.randomUUID();
  let file: File;
  let headers: Record<string, string>;
  try {
    file = new File(picked.uri);
    const size = file.size ?? picked.size;
    const sha256 = await file.digest("SHA-256");
    headers = uploadHeaders({ ...picked, size }, sha256);
  } catch {
    return { kind: "failed", message: "Couldn't read this file. Pick it again." };
  }
  let last: UploadAnswer = { kind: "retry", message: "The upload didn't go through." };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (options.signal.aborted) return { kind: "failed", message: "Cancelled." };
    if (attempt > 0) {
      await sleep(retryDelay(attempt - 1));
      if (options.signal.aborted) return { kind: "failed", message: "Cancelled." };
      // The last answer was lost, but the file may have arrived: don't send it again if so.
      const status = await safe(api.uploads.status({ uploadId }));
      if (status.data?.status === "complete" && status.data.attachment)
        return { kind: "complete", attachment: status.data.attachment };
    }
    const cookie = await sessionCookie();
    if (options.signal.aborted) return { kind: "failed", message: "Cancelled." };
    const task = file.createUploadTask(uploadUrl(APP_URL, uploadId), {
      signal: options.signal,
      httpMethod: "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      onProgress: ({ bytesSent, totalBytes }) =>
        options.onProgress(totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : 0),
    });
    try {
      const result = await task.uploadAsync();
      last = result
        ? readUploadAnswer(result.status, result.body)
        : { kind: "retry", message: "The upload didn't go through." };
    } catch {
      if (options.signal.aborted) return { kind: "failed", message: "Cancelled." };
      last = { kind: "retry", message: "Couldn't reach open-bot. Trying again." };
    }
    if (last.kind !== "retry") return last;
  }
  return last.kind === "retry"
    ? { kind: "failed", message: "The upload didn't go through. Check your connection." }
    : last;
}
