/** Telegram's limit on one message's text. */
export const TELEGRAM_MAX_CHARS = 4096;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline Markdown on one line of text: code, links, bold and italics. */
function inline(line: string): string {
  // Code spans first, so nothing inside them is formatted.
  const parts = line.split(/(`[^`\n]+`)/);
  return parts
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      // The text is escaped already, so a URL only needs its quotes escaped.
      let text = escapeHtml(part);
      text = text.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
      );
      text = text.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "<b>$1</b>");
      text = text.replace(/__(\S(?:[^_\n]*\S)?)__/g, "<b>$1</b>");
      text = text.replace(/(^|[^\w*])\*(\S(?:[^*\n]*\S)?)\*(?!\w)/g, "$1<i>$2</i>");
      text = text.replace(/(^|[^\w])_(\S(?:[^_\n]*\S)?)_(?!\w)/g, "$1<i>$2</i>");
      text = text.replace(/~~(\S(?:[^~\n]*\S)?)~~/g, "<s>$1</s>");
      return text;
    })
    .join("");
}

/**
 * A teammate's Markdown reply as Telegram HTML: bold, italics, code, links, headings and lists.
 * Anything else stays as plain text, so a reply always arrives readable.
 */
export function telegramHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]!); i += 1) code.push(lines[i]!);
      out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1]!.trim())}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]!.replace(/\t/g, "  ")}• ${inline(bullet[2]!)}`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push("──────");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
      continue;
    }
    out.push(inline(line));
  }
  return out
    .join("\n")
    .replace(/<\/blockquote>\n<blockquote>/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split text into messages Telegram accepts, at paragraph or line breaks where possible. Splitting
 * never cuts inside an HTML tag, but formatting that spans a split is closed and reopened by
 * Telegram as plain text, so callers split plain text or short HTML.
 */
export function splitTelegram(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) cut = max;
    const open = window.lastIndexOf("<", cut);
    if (open > window.lastIndexOf(">", cut)) cut = open;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** A code to link a Telegram chat: short enough to type, and hard to guess. */
export function newLinkCode(random: (size: number) => Uint8Array): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(random(8), (byte) => alphabet[byte % alphabet.length]).join("");
}
