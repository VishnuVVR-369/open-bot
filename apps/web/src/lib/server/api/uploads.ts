import "server-only";
import { uploadHeaders, type UploadFile, type UploadView } from "@open-bot/api";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/domain";
import { serverEnv } from "../env";
import { worker, WorkerError } from "../worker";

export interface UploadMeta extends UploadFile {
  sha256: string;
}

/**
 * Write an attachment on the computer, through the worker, which keeps one record per upload id:
 * a retry with the same id writes the same file, and a finished one is returned as it is.
 */
export async function putUpload(
  uploadId: string,
  meta: UploadMeta,
  body: ReadableStream<Uint8Array>,
): Promise<UploadView> {
  if (meta.size > MAX_UPLOAD_BYTES)
    throw new WorkerError(413, `Files can be up to ${MAX_UPLOAD_LABEL}.`);
  let response: Response;
  try {
    response = await fetch(`${serverEnv.workerUrl}/internal/uploads/${uploadId}`, {
      method: "PUT",
      headers: {
        "x-worker-secret": serverEnv.workerSecret,
        ...uploadHeaders(meta, meta.sha256),
      },
      body,
      // Streams the upload through without holding it here first.
      duplex: "half",
      cache: "no-store",
      signal: AbortSignal.timeout(300_000),
    } as RequestInit);
  } catch {
    throw new WorkerError(503, "open-bot couldn't reach the computer. Try again in a moment.");
  }
  const data = (await response.json().catch(() => ({}))) as UploadView & { error?: string };
  if (!response.ok)
    throw new WorkerError(response.status, data.error ?? `Worker returned ${response.status}`);
  return data;
}

export async function uploadStatus(uploadId: string): Promise<UploadView> {
  return worker.uploads.status({ uploadId });
}
