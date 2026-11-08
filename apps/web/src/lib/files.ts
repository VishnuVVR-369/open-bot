export { COMPUTER_FILE_PATH, fileKind, type FileKind } from "@open-bot/domain";

export function fileUrl(path: string, inline = false): string {
  return `/api/files/download?${inline ? "inline=1&" : ""}path=${encodeURIComponent(path)}`;
}
