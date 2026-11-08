/** Files on the computer, as the apps show them. */

/** How the app can show a file, by its name. */
export type FileKind = "image" | "pdf" | "markdown" | "csv" | "text" | "other";

const TEXT = new Set([
  "txt",
  "log",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "svg",
  "ics",
  "vcf",
  "srt",
  "tex",
]);

export function fileKind(name: string): FileKind {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "csv" || extension === "tsv") return "csv";
  if (TEXT.has(extension)) return "text";
  return "other";
}

/**
 * Paths to files on the computer in a teammate's reply, like `/home/bot/shared/report.md`.
 * A file needs an extension, so folders stay plain text; trailing punctuation isn't part of it.
 */
export const COMPUTER_FILE_PATH =
  /\/home\/bot\/[^\s`'"()<>[\]{},;]*[^\s`'"()<>[\]{},;.:!?]\.[A-Za-z0-9]{1,8}\b/g;

/** Text split into plain parts and paths to files on the computer, in order. */
export function splitComputerPaths(text: string): { text: string; path: boolean }[] {
  const parts: { text: string; path: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(COMPUTER_FILE_PATH)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), path: false });
    parts.push({ text: match[0], path: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), path: false });
  return parts;
}

/** The largest file you can attach or upload to the computer. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "40 MB";
