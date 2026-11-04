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
}): ApprovalRisk | null {
  switch (approval.kind) {
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
