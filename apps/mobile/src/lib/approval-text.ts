import { shellScript } from "@open-bot/shared";

/** A title split where it quotes code in backticks, as "Run `pwd`" does. */
export function titleParts(title: string): { text: string; code: boolean }[] {
  const pieces = title.split("`");
  // An odd backtick out means it isn't quoting anything: show it as written.
  if (pieces.length % 2 === 0) return [{ text: title, code: false }];
  return pieces
    .map((text, index) => ({ text, code: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}

const PATH = /^(["'`]?)((?:~|\.{1,2})?\/[^\s"'`]+)(["'`]?[.,:;]?)$/;

/**
 * A title short enough for two lines in a list, keeping what tells paths apart: their start and
 * the last two parts ("/home/…/shared/old-notes.txt"). Short titles stay as they are.
 */
export function shortenPaths(text: string, max = 64): string {
  if (text.length <= max) return text;
  return text
    .split(" ")
    .map((word) => {
      const match = PATH.exec(word);
      if (!match) return word;
      const [, open, path, close] = match;
      const parts = path!.split("/");
      // ["", "home", "bot", "shared", "x.txt"]: keep the root's first part and the last two.
      if (parts.length <= 4) return word;
      return `${open}${[...parts.slice(0, 2), "…", ...parts.slice(-2)].join("/")}${close}`;
    })
    .join(" ");
}

/** A command's approval detail in its parts: why, the command itself, and where it runs. */
export function commandParts(detail: string): {
  reason: string | null;
  command: string | null;
  cwd: string | null;
} {
  const lines = detail.split("\n");
  const start = lines.findIndex((line) => line.startsWith("$ "));
  if (start < 0) return { reason: detail.trim() || null, command: null, cwd: null };
  const rest = lines.slice(start);
  const last = rest.at(-1) ?? "";
  const cwd = rest.length > 1 && last.startsWith("in ") ? last.slice(3) : null;
  const command = (cwd ? rest.slice(0, -1) : rest).join("\n").slice(2);
  return {
    reason: lines.slice(0, start).join("\n").trim() || null,
    command: shellScript(command),
    cwd,
  };
}

const DESTRUCTIVE_COMMAND = [
  /(^|[\s;&|(])(sudo\s+)?(rm|rmdir|unlink|shred|wipefs|mkfs(\.\w+)?)(\s|$)/,
  /\bdd\s[^;|&]*\bof=/,
  /\bfind\s[^;|&]*\s-delete\b/,
  /\bgit\s+(push\s[^;|&]*(--force|\s-f)\b|reset\s+--hard|clean\s+-\w*f)/,
  /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b/i,
];

const DESTRUCTIVE_WORDS = /\b(delete|deletes|remove|removes|erase|wipe|drop)\b/i;

/** `label` is a few words for a chip; `text` is the sentence for the full request. */
export type ApprovalRisk = { tone: "destructive" | "attention"; label: string; text: string };

/** What's worth a second look before approving: deleting things, spending money, sending mail. */
export function approvalRisk(approval: {
  kind: string;
  title: string;
  detail: string;
  subject?: string | null;
  preview?: { type: string } | null;
}): ApprovalRisk | null {
  // Mail sent through a connected account is still mail, and reads the same.
  const kind =
    approval.kind === "account_outward" && sendsEmail(approval) ? "email" : approval.kind;
  switch (kind) {
    case "purchase":
      return {
        tone: "attention",
        label: "Spends money",
        text: "This spends money. You confirm it with your fingerprint.",
      };
    case "email":
      return {
        tone: "attention",
        label: "Sends an email",
        text: "This sends an email in your name. It can't be unsent.",
      };
    case "account_outward":
      return DESTRUCTIVE_WORDS.test(approval.title)
        ? {
            tone: "destructive",
            label: "Deletes something",
            text: "This deletes something others can see. It may not come back.",
          }
        : {
            tone: "attention",
            label: "Acts as you",
            text: "Other people see this, and it comes from you.",
          };
    case "command": {
      const command = approval.subject ?? commandParts(approval.detail).command ?? approval.title;
      return DESTRUCTIVE_COMMAND.some((pattern) => pattern.test(shellScript(command)))
        ? {
            tone: "destructive",
            label: "Can't be undone",
            text: "This can delete or overwrite things for good.",
          }
        : null;
    }
    default:
      return DESTRUCTIVE_WORDS.test(approval.title)
        ? {
            tone: "destructive",
            label: "Deletes something",
            text: "This deletes something. It may not come back.",
          }
        : null;
  }
}

const DETAIL_ROW = /^([A-Z][A-Za-z ]{0,18}):\s+(.+)$/;

/**
 * A detail written as "Label: value" lines (an itinerary, a card), split into a summary and
 * labeled rows, so it reads as a table instead of a paragraph. Null when it isn't shaped that way.
 */
export function detailRows(
  detail: string,
): { summary: string | null; rows: { label: string; value: string }[] } | null {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const rows: { label: string; value: string }[] = [];
  const rest: string[] = [];
  for (const line of lines) {
    const match = DETAIL_ROW.exec(line);
    // Rows come after the summary; prose after the first row means it isn't a table.
    if (match) rows.push({ label: match[1]!, value: match[2]!.replace(/\.$/, "") });
    else if (rows.length === 0) rest.push(line);
    else return null;
  }
  if (rows.length < 2) return null;
  return { summary: rest.join(" ") || null, rows };
}

const AMOUNT = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP))/;

/** Whether an approval sends an email, whichever way it gets sent. */
export function sendsEmail(approval: {
  kind: string;
  title: string;
  preview?: { type: string } | null;
}): boolean {
  return (
    approval.kind === "email" ||
    approval.preview?.type === "email" ||
    /^(send|reply|forward)\b.*\b(email|e-mail|mail|reply)\b/i.test(approval.title)
  );
}

/** The approve button's words: what approving does, when the request says it plainly. */
export function approveLabel(approval: {
  kind: string;
  title: string;
  preview?: { type: string } | null;
}): string {
  if (approval.kind === "purchase") {
    const amount = AMOUNT.exec(approval.title)?.[0];
    return amount ? `Approve ${amount}` : "Approve purchase";
  }
  if (sendsEmail(approval)) return "Approve and send";
  return "Approve";
}
