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

export function fileUrl(path: string, inline = false): string {
  return `/api/files/download?${inline ? "inline=1&" : ""}path=${encodeURIComponent(path)}`;
}

/**
 * Paths to files on the computer in a teammate's reply, like `/home/bot/shared/report.md`.
 * A file needs an extension, so folders stay plain text; trailing punctuation isn't part of it.
 */
export const COMPUTER_FILE_PATH =
  /\/home\/bot\/[^\s`'"()<>[\]{},;]*[^\s`'"()<>[\]{},;.:!?]\.[A-Za-z0-9]{1,8}\b/g;
