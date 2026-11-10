import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/domain";
import { uploadViewSchema, type Attachment, type UploadView } from "./views";

/**
 * The client side of `PUT /api/uploads/<uploadId>`, without the platform: what to send, what an
 * answer means, and when to send again. The web app and the phone each only send the bytes.
 *
 * Attachments are uploaded as raw bytes, described by the headers below, then sent with a
 * message. Retrying an upload with the same id never stores it twice.
 */
export const UPLOAD_HEADERS = {
  /** The file's name, URI-encoded. */
  name: "x-upload-name",
  mime: "x-upload-mime",
  /** The size in bytes. */
  size: "x-upload-size",
  /** The SHA-256 of the file, in hex. */
  sha256: "x-upload-sha256",
} as const;

export interface UploadFile {
  name: string;
  mime: string;
  size: number;
}

export function uploadUrl(appUrl: string, uploadId: string): string {
  return `${appUrl}/api/uploads/${uploadId}`;
}

export function uploadHeaders(file: UploadFile, sha256: string): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    [UPLOAD_HEADERS.name]: encodeURIComponent(file.name),
    [UPLOAD_HEADERS.mime]: encodeURIComponent(file.mime),
    [UPLOAD_HEADERS.size]: String(file.size),
    [UPLOAD_HEADERS.sha256]: sha256,
  };
}

/** Why a file can't be attached at all, before trying. */
export function cantAttach(file: Pick<UploadFile, "size">): string | null {
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

export interface UploadTransport {
  /**
   * Send the bytes once, under the upload's one id. Resolves with the HTTP answer (null when the
   * platform got none) and rejects when the request never got through.
   */
  send(): Promise<{ status: number; body: string } | null>;
  /** How the upload went (`api.uploads.status`), asked before sending it again. */
  status(): Promise<UploadView | null>;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const CANCELLED: UploadAnswer = { kind: "failed", message: "Cancelled." };

/**
 * Upload with retries. Every attempt uses the same id, so a retry after a lost answer never
 * stores the file twice, and before sending it again it asks whether the last attempt made it.
 */
export async function uploadWithRetries(transport: UploadTransport): Promise<UploadAnswer> {
  const { signal } = transport;
  const sleep = transport.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  let last: UploadAnswer = { kind: "retry", message: "The upload didn't go through." };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return CANCELLED;
    if (attempt > 0) {
      await sleep(retryDelay(attempt - 1));
      if (signal.aborted) return CANCELLED;
      // The last answer was lost, but the file may have arrived: don't send it again if so.
      const status = await transport.status().catch(() => null);
      if (status?.status === "complete" && status.attachment)
        return { kind: "complete", attachment: status.attachment };
    }
    try {
      const answer = await transport.send();
      last = answer
        ? readUploadAnswer(answer.status, answer.body)
        : { kind: "retry", message: "The upload didn't go through." };
    } catch {
      if (signal.aborted) return CANCELLED;
      last = { kind: "retry", message: "Couldn't reach open-bot. Trying again." };
    }
    if (last.kind !== "retry") return last;
  }
  return last.kind === "retry"
    ? { kind: "failed", message: "The upload didn't go through. Check your connection." }
    : last;
}
