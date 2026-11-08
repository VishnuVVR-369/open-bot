import { fileKind } from "@open-bot/domain";
import { Directory, File, Paths } from "expo-file-system";
import { sessionCookie } from "./auth";
import { APP_URL } from "./config";
import { FileError } from "./errors";

/** A file on the computer, as the web serves it to you. */
export function fileUrl(path: string, inline = true): string {
  return `${APP_URL}/api/files/download?${inline ? "inline=1&" : ""}path=${encodeURIComponent(path)}`;
}

export const fileName = (path: string) => path.split("/").pop() || "file";

/** The headers that make a file request yours. */
export async function fileHeaders(): Promise<Record<string, string>> {
  const cookie = await sessionCookie();
  return cookie ? { cookie } : {};
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function mimeOf(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (MIME[extension]) return MIME[extension];
  const kind = fileKind(name);
  if (kind === "markdown" || kind === "text") return "text/plain";
  if (kind === "csv") return "text/csv";
  return "application/octet-stream";
}

/** Fetches a text file from the computer. */
export async function readTextFile(path: string): Promise<string> {
  const response = await fetch(fileUrl(path), { headers: await fileHeaders() });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new FileError(response.status, body?.error ?? "Couldn't open the file.");
  }
  return response.text();
}

/**
 * Downloads a file to the phone's cache and opens it in an app that can show it (a PDF viewer,
 * a spreadsheet app). Each file gets its own folder, so the name stays the same.
 */
export async function openInApp(path: string, name = fileName(path)): Promise<void> {
  const folder = new Directory(Paths.cache, "files", encodeURIComponent(path).slice(-120));
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  const target = new File(folder, name);
  const file = await File.downloadFileAsync(fileUrl(path, false), target, {
    headers: await fileHeaders(),
    idempotent: true,
  });
  const mimeType = mimeOf(name);
  if (!(await file.canPreview({ mimeType })))
    throw new Error("No app on this phone can open this kind of file.");
  await file.preview({ title: name, mimeType });
}
