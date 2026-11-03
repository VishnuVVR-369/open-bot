/** Text as the apps show it, the same on the web and the phone. */

/** Markdown as plain text on one line, for previews and notifications. */
export function plainText(markdown: string): string {
  return (
    markdown
      // A code block's fences (and the language after the opening one) aren't part of its text.
      .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*(?:>|[-*+]\s|\d+\.\s)\s*/gm, "")
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])[*_](?!\s)([^*_\n]+?)(?<!\s)[*_](?![\w*])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Markdown as something to say: each line its own sentence, so lists get their pauses. */
export function speakable(markdown: string): string {
  return markdown
    .split(/\n+/)
    .map((line) => plainText(line))
    .filter(Boolean)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

/** 18200 as "18.2K". */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** How long something took, like "42s", "3m 5s" or "1h 2m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
