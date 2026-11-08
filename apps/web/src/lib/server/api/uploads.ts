import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { UPLOAD_HEADERS, type UploadView } from "@open-bot/api";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/domain";
import { serverEnv } from "../env";
import { worker, WorkerError } from "../worker";

export interface UploadMeta {
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

/**
 * Write an attachment on the computer, through the worker, which keeps one record per upload id:
 * a retry with the same id writes the same file, and a finished one is returned as it is.
 */
export async function putUpload(
  uploadId: string,
  meta: UploadMeta,
  body: ReadableStream<Uint8Array> | Buffer,
): Promise<UploadView> {
  if (meta.size > MAX_UPLOAD_BYTES)
    throw new WorkerError(413, `Files can be up to ${MAX_UPLOAD_LABEL}.`);
  let response: Response;
  try {
    response = await fetch(`${serverEnv.workerUrl}/internal/uploads/${uploadId}`, {
      method: "PUT",
      headers: {
        "x-worker-secret": serverEnv.workerSecret,
        "content-type": "application/octet-stream",
        [UPLOAD_HEADERS.name]: encodeURIComponent(meta.name),
        [UPLOAD_HEADERS.mime]: encodeURIComponent(meta.mime),
        [UPLOAD_HEADERS.size]: String(meta.size),
        [UPLOAD_HEADERS.sha256]: meta.sha256,
      },
      body: body instanceof Buffer ? new Uint8Array(body) : body,
      // Streams the phone's upload through without holding it here first.
      ...(body instanceof Buffer ? {} : { duplex: "half" }),
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

/** Upload a file the web app picked, under a new id: the browser doesn't retry it on its own. */
export async function uploadFormFile(file: File): Promise<UploadView> {
  const data = Buffer.from(await file.arrayBuffer());
  return putUpload(
    randomUUID(),
    {
      name: file.name || "file",
      mime: file.type || "application/octet-stream",
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
    data,
  );
}

export async function uploadStatus(uploadId: string): Promise<UploadView> {
  return worker.uploads.status({ uploadId });
}
