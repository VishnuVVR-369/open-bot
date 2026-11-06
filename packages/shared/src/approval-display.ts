import { shellScript } from "./approval-rules";

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

/** The parts of an approval that say what it does. */
export interface ApprovalFacts {
  kind: string;
  title: string;
  detail: string;
  subject?: string | null;
  /** The kind of account action it previews, when it has one. */
  previewType?: "email" | "event" | "change" | null;
}

/** What's worth a second look before approving: deleting things, spending money, sending mail. */
export function approvalRisk(approval: ApprovalFacts): ApprovalRisk | null {
  if (approval.kind === "email" || approval.previewType === "email")
    return {
      tone: "attention",
      label: "Sends an email",
      text: "This sends an email in your name. It can't be unsent.",
    };
  switch (approval.kind) {
    case "purchase":
      return {
        tone: "attention",
        label: "Spends money",
        text: "This spends money. You confirm it with your fingerprint.",
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

/** The amount a purchase approval pays, as its title states it: "Pay $842.30 at TAP". */
export function approvalAmount(title: string): string | null {
  return /^Pay\s+(\$\d[\d,]*(?:\.\d{1,2})?)\b/.exec(title.trim())?.[1] ?? null;
}

/** The approve button's label, saying what approving does: "Approve $842.30". */
export function approveLabel(approval: ApprovalFacts): string {
  if (approval.kind === "purchase") {
    const amount = approvalAmount(approval.title);
    return amount ? `Approve ${amount}` : "Approve payment";
  }
  if (approval.kind === "email" || approval.previewType === "email") return "Approve and send";
  return "Approve";
}

/** One "Label: value" line of an approval's detail. */
export interface DetailField {
  label: string;
  value: string;
}

/**
 * An approval's detail split for display: free text, then "Label: value" lines as fields.
 * `fields` stays empty unless at least two lines are labeled, so prose with one colon in it
 * still reads as prose. Commands have their own shape (see `commandParts`) and never split.
 */
export function detailFields(detail: string): { text: string[]; fields: DetailField[] } {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => line.startsWith("$ "))) return { text: lines, fields: [] };
  const text: string[] = [];
  const fields: DetailField[] = [];
  for (const line of lines) {
    const match = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,2}):\s+(\S.*)$/.exec(line);
    if (match) fields.push({ label: match[1]!, value: match[2]!.replace(/\.$/, "") });
    else text.push(line);
  }
  return fields.length >= 2 ? { text, fields } : { text: lines, fields: [] };
}
