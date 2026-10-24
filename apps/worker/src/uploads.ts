import { randomUUID } from "node:crypto";
import { COMPUTER_PATHS } from "@open-bot/shared";
import type { Context } from "./context";

/** Where files you attach to messages go on the computer. */
export const UPLOAD_DIR = `${COMPUTER_PATHS.shared}/uploads`;

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "file"
  );
}

/** Save an attachment on the computer, under a name that can't clash with another upload. */
export async function saveUpload(
  ctx: Pick<Context, "codex">,
  name: string,
  dataBase64: string,
): Promise<{ path: string; size: number }> {
  const client = await ctx.codex.ready();
  await client.request("fs/createDirectory", { path: UPLOAD_DIR, recursive: true });
  const path = `${UPLOAD_DIR}/${randomUUID().slice(0, 8)}-${sanitizeFileName(name)}`;
  await client.request("fs/writeFile", { path, dataBase64 });
  return { path, size: Buffer.byteLength(dataBase64, "base64") };
}
