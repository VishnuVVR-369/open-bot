/**
 * Text shared into open-bot from another app (Android's share sheet), and the message it
 * becomes. Platform-free, so it's tested in Node.
 */

/** What another app shared: its text and, when it sent one, a subject (often the page title). */
export interface SharedText {
  text: string;
  subject: string | null;
}

/** The most text a share keeps; a message can be longer, but a share this long is a mistake. */
export const MAX_SHARED_CHARS = 20_000;

/** A shared item as the share screen shows it: the link in it, if any, and the words around it. */
export interface SharedItem {
  url: string | null;
  /** The shared words without the link, or the subject when that's all there is. */
  text: string;
  /** Everything that was shared, as it goes in the message. */
  full: string;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/i;

/** Trailing punctuation that ends a sentence, not a link. */
function trimUrl(url: string): string {
  return url.replace(/[)\].,;:!?]+$/, "");
}

export function parseShared(shared: SharedText): SharedItem | null {
  const text = shared.text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_SHARED_CHARS);
  const subject = shared.subject?.replace(/\s+/g, " ").trim() ?? "";
  if (!text && !subject) return null;
  const match = URL_PATTERN.exec(text);
  const url = match ? trimUrl(match[0]) : null;
  const rest = url
    ? (text.slice(0, match!.index) + text.slice(match!.index + match![0].length))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text;
  // Apps often repeat the title as the subject; only add it when it says something new.
  const words = rest || (subject && !text.includes(subject) ? subject : "");
  const full = [subject && !text.includes(subject) ? subject : "", text].filter(Boolean).join("\n");
  return { url, text: words, full };
}

export type SharePreset = "page" | "summary" | "send";

export const SHARE_PRESETS: { id: SharePreset; label: string; hint: string }[] = [
  {
    id: "page",
    label: "Make a page explaining this",
    hint: "Researches it and builds a page you open in the app",
  },
  { id: "summary", label: "Summarize it for me", hint: "A short reply in the chat" },
  { id: "send", label: "Just send it", hint: "Sends what you shared, and your note" },
];

/** The message a share becomes, for the preset you picked and your note (if any). */
export function shareMessage(preset: SharePreset, item: SharedItem, note: string): string {
  const extra = note.trim();
  const shared = item.full;
  switch (preset) {
    case "page":
      return ["/page Research this and make a page that explains it in depth.", extra, "", shared]
        .filter((line, index) => index !== 1 || line)
        .join("\n");
    case "summary":
      return [
        "Read this and give me a short summary: what it says, and what matters about it.",
        extra,
        "",
        shared,
      ]
        .filter((line, index) => index !== 1 || line)
        .join("\n");
    case "send":
      return extra ? `${extra}\n\n${shared}` : shared;
  }
}
