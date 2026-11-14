import type { ApprovalFacts } from "@open-bot/domain";

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
      // /home/bot/shared/x.txt splits into 5 parts: keep the root's first part and the last two.
      if (parts.length <= 4) return word;
      return `${open}${[...parts.slice(0, 2), "…", ...parts.slice(-2)].join("/")}${close}`;
    })
    .join(" ");
}

/**
 * An approval as the shared helpers (`approvalRisk`, `approveLabel`) read it. Mail sent through
 * a connected account is still mail, so it reads as an email.
 */
export function approvalFacts(approval: {
  kind: string;
  title: string;
  detail?: string | null;
  subject?: string | null;
  preview?: { type: string } | null;
}): ApprovalFacts {
  const type = approval.preview?.type;
  return {
    kind: approval.kind === "account_outward" && sendsEmail(approval) ? "email" : approval.kind,
    title: approval.title,
    detail: approval.detail ?? "",
    subject: approval.subject ?? null,
    previewType: type === "email" || type === "event" || type === "change" ? type : null,
  };
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
