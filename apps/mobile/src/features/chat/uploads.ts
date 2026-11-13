import { uploadHeaders, uploadUrl, uploadWithRetries, type UploadAnswer } from "@open-bot/api";
import * as Crypto from "expo-crypto";
import { File, UploadType } from "expo-file-system";
import { api } from "../../lib/api";
import { sessionCookie } from "../../lib/auth";
import { APP_URL } from "../../lib/config";

/** A file picked on the phone, read from disk when it's sent. */
export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

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
  const url = uploadUrl(APP_URL, uploadId);
  return uploadWithRetries({
    signal: options.signal,
    status: () => api.uploads.status({ uploadId }),
    send: async () => {
      const cookie = await sessionCookie();
      if (options.signal.aborted) throw new Error("Cancelled.");
      const task = file.createUploadTask(url, {
        signal: options.signal,
        httpMethod: "PUT",
        uploadType: UploadType.BINARY_CONTENT,
        headers: { ...headers, ...(cookie ? { cookie } : {}) },
        onProgress: ({ bytesSent, totalBytes }) =>
          options.onProgress(totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : 0),
      });
      return (await task.uploadAsync()) ?? null;
    },
  });
}
