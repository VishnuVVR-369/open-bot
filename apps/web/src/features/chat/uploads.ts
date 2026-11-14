import {
  cantAttach,
  uploadHeaders,
  uploadUrl,
  uploadWithRetries,
  type Attachment,
  type UploadFile,
} from "@open-bot/api";
import { type Result } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";

/** What the upload says about a file the browser picked or pasted (a paste has no name). */
export function describeFile(file: File): UploadFile {
  return {
    name: file.name || "pasted-image.png",
    mime: file.type || "application/octet-stream",
    size: file.size,
  };
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload a file as an attachment, the same way the phone does (`PUT /api/uploads/<id>`, see
 * `@open-bot/api`): one id for every attempt, so a retry after a lost answer never stores it twice.
 */
export async function uploadAttachment(
  file: File,
  signal: AbortSignal = new AbortController().signal,
): Promise<Result<Attachment>> {
  const described = describeFile(file);
  const refused = cantAttach(described);
  if (refused) return { ok: false, error: refused };
  // The browser only hashes on https (or localhost).
  if (!globalThis.crypto?.subtle)
    return { ok: false, error: "Attaching files needs a secure (https) connection." };
  let headers: Record<string, string>;
  try {
    headers = uploadHeaders(described, await sha256(file));
  } catch {
    return { ok: false, error: "Couldn't read this file. Pick it again." };
  }
  const uploadId = crypto.randomUUID();
  const answer = await uploadWithRetries({
    signal,
    status: () => api.uploads.status({ uploadId }),
    send: async () => {
      const response = await fetch(uploadUrl(window.location.origin, uploadId), {
        method: "PUT",
        headers,
        body: file,
        signal,
      });
      return { status: response.status, body: await response.text() };
    },
  });
  switch (answer.kind) {
    case "complete":
      return { ok: true, data: answer.attachment };
    case "signedOut":
      window.location.assign("/login");
      return { ok: false, error: "Sign in first." };
    default:
      return { ok: false, error: answer.message };
  }
}
