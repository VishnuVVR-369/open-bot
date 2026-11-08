import { UPLOAD_HEADERS, uploadViewSchema, type Attachment } from "@open-bot/api";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/domain";

/**
 * Talking to `PUT /api/uploads/<id>`, without the platform: what to send, and what an answer
 * means. Tested in Node; `uploads.ts` does the sending.
 */

export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

export function uploadUrl(appUrl: string, uploadId: string): string {
  return `${appUrl}/api/uploads/${uploadId}`;
}

export function uploadHeaders(file: Omit<PickedFile, "uri">, sha256: string) {
  return {
    "content-type": "application/octet-stream",
    [UPLOAD_HEADERS.name]: encodeURIComponent(file.name),
    [UPLOAD_HEADERS.mime]: encodeURIComponent(file.mime),
    [UPLOAD_HEADERS.size]: String(file.size),
    [UPLOAD_HEADERS.sha256]: sha256,
  };
}

/** Why a file can't be attached at all, before trying. */
export function cantAttach(file: Pick<PickedFile, "size">): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return `Files can be up to ${MAX_UPLOAD_LABEL}.`;
  return null;
}

export type UploadAnswer =
  | { kind: "complete"; attachment: Attachment }
  /** Worth sending again with the same id: the network or the server had a moment. */
  | { kind: "retry"; message: string }
  /** Sending it again won't help. */
  | { kind: "failed"; message: string }
  | { kind: "signedOut" };

export function readUploadAnswer(status: number, body: string): UploadAnswer {
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Not JSON: something in front of open-bot answered.
  }
  const error =
    json && typeof json === "object" && "error" in json && typeof json.error === "string"
      ? json.error
      : null;
  if (status === 401) return { kind: "signedOut" };
  if (status >= 200 && status < 300) {
    const parsed = uploadViewSchema.safeParse(json);
    if (parsed.success && parsed.data.status === "complete" && parsed.data.attachment)
      return { kind: "complete", attachment: parsed.data.attachment };
    return { kind: "retry", message: "The upload didn't finish. Trying again." };
  }
  // A transfer cut short arrives as a 400 from the size and hash check: send it again.
  if (status === 400 && error?.includes("didn't arrive in one piece"))
    return { kind: "retry", message: error };
  if (status >= 500 || status === 408 || status === 429)
    return { kind: "retry", message: error ?? "open-bot isn't answering right now." };
  return { kind: "failed", message: error ?? `The upload was refused (${status}).` };
}

/** How long to wait before the next attempt. */
export function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 15_000);
}

export const MAX_ATTEMPTS = 5;
