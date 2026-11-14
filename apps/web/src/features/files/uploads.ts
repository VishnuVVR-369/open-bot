import { cantAttach, UPLOAD_HEADERS } from "@open-bot/api";
import { UNREACHABLE, type Result } from "@/lib/client/mutate";
import { goToSignIn } from "@/lib/client/sign-in";

/**
 * Put a file into a folder on the computer (`PUT /api/files/upload`), answering with its path.
 * Sent once: a taken name gets a number, so sending it again would make a second copy.
 */
export async function uploadToFolder(dir: string, file: File): Promise<Result<string>> {
  const refused = cantAttach(file);
  if (refused) return { ok: false, error: refused };
  let response: Response;
  try {
    response = await fetch(`/api/files/upload?dir=${encodeURIComponent(dir)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        [UPLOAD_HEADERS.name]: encodeURIComponent(file.name),
      },
      body: file,
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
  if (response.status === 401) {
    goToSignIn();
    return { ok: false, error: "Sign in first." };
  }
  if (!response.ok || !body.path)
    return { ok: false, error: body.error ?? `The upload was refused (${response.status}).` };
  return { ok: true, data: body.path };
}
