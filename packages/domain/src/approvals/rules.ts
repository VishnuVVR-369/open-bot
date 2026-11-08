/**
 * What a teammate asks you about. Purchases, emails and outward actions on your accounts always
 * ask: no rule covers spending money, or acting as you where other people see it.
 * `account_write` is a change to one of your accounts only you see; a rule names its tool.
 */
export type ApprovalKind =
  "command" | "file_change" | "action" | "purchase" | "email" | "account_write" | "account_outward";

/** What an "always allow" rule can cover. */
export type RuleKind = Exclude<ApprovalKind, "purchase" | "email" | "account_outward">;

/** Approvals that act by themselves when you decide, even long after their run ended. */
export const DEFERRED_APPROVAL_KINDS = [
  "action",
  "purchase",
  "email",
  "account_write",
  "account_outward",
] as const satisfies readonly ApprovalKind[];

/** Whether "always allow" can be offered for this kind. */
export function ruleAllowed(kind: ApprovalKind): kind is RuleKind {
  return kind !== "purchase" && kind !== "email" && kind !== "account_outward";
}

/**
 * The empty "Always allowed" list, on the web and the phone. Only some approvals offer
 * "Always allow" (commands and other routine work); payments and emails always ask.
 */
export function noRulesYet(name: string): string {
  return `Nothing yet. Command approvals offer "Always allow": choose it and ${name} stops asking about commands like that one. Payments and emails always ask.`;
}

export interface ApprovalRule {
  kind: RuleKind;
  pattern: string;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/;

/** The script a `/bin/bash -lc '…'` wrapper runs, which is how Codex sends commands. */
export function shellScript(command: string): string {
  const trimmed = command.trim();
  const match = SHELL_WRAPPER.exec(trimmed);
  if (!match) return trimmed;
  const argument = match[1]!.trim();
  if (/^'[\s\S]*'$/.test(argument)) return argument.slice(1, -1).replaceAll(`'\\''`, "'");
  if (/^"[\s\S]*"$/.test(argument)) return argument.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return argument;
}

/**
 * The simple commands in a script, split on `;`, `&&`, `||`, `|`, `&` and new lines.
 * Null when the script redirects or substitutes, since a prefix can't say what that does.
 */
export function simpleCommands(script: string): string[] | null {
  if (/[`<>]|\$\(/.test(script)) return null;
  return script
    .split(/&&|\|\||[;|&\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function commandCovered(prefix: string, command: string): boolean {
  const start = normalize(prefix);
  const text = normalize(command);
  return start.length > 0 && (text === start || text.startsWith(`${start} `));
}

/**
 * Whether a bot's "always allow" rules cover a request.
 * A command is covered when every command it chains starts with an allowed prefix, on word
 * boundaries. An action is covered by a rule with the same wording. A file change rule covers
 * every file change.
 */
export function rulesCover(rules: ApprovalRule[], kind: ApprovalKind, text: string): boolean {
  const relevant = rules.filter((rule) => rule.kind === kind);
  if (relevant.length === 0) return false;
  switch (kind) {
    case "file_change":
      return true;
    case "command": {
      const commands = simpleCommands(shellScript(text));
      if (!commands || commands.length === 0) return false;
      return commands.every((command) =>
        relevant.some((rule) => commandCovered(rule.pattern, command)),
      );
    }
    case "action":
    case "account_write":
      return relevant.some((rule) => normalize(rule.pattern) === normalize(text));
    case "purchase":
    case "email":
    case "account_outward":
      return false;
  }
}

/**
 * Whether an approval you gave quotes this exact command, so asking about running it would ask
 * you the same thing twice. The whole script must appear on its own, not inside a longer word or
 * path: approving `rm -f a.txt` doesn't cover `rm -f a`.
 */
export function approvalQuotes(approved: string, command: string): boolean {
  const script = shellScript(command).replace(/\s+/g, " ").trim();
  if (!script) return false;
  const text = approved.replace(/\s+/g, " ");
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s\`'"(])${escaped}(?=$|[\\s\`'",;:)]|\\.(?:\\s|$))`).test(text);
}

/** A sensible rule for a request: the first command's program and subcommand, or the action. */
export function suggestedRule(kind: ApprovalKind, subject: string): string {
  if (!ruleAllowed(kind) || kind === "file_change") return "";
  if (kind === "action" || kind === "account_write") return subject.trim();
  const script = shellScript(subject);
  const first = simpleCommands(script)?.[0] ?? script;
  return first.split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
}

/** Why a rule pattern can't be saved, or null when it can. */
export function invalidRulePattern(kind: ApprovalKind, pattern: string): string | null {
  if (kind === "file_change") return null;
  if (kind === "purchase")
    return "Purchases always ask you. Set an amount to approve on its own instead.";
  if (kind === "email" || kind === "account_outward")
    return "Anything others see from you always asks you.";
  const clean = pattern.trim();
  if (!clean) return "Say what to allow.";
  if (kind === "command") {
    if (simpleCommands(clean)?.length !== 1) return "Allow one command, without ; && | or >.";
    if (SHELL_WRAPPER.test(`${clean} x`) || /^(?:\S*\/)?(?:ba|z)?sh$/.test(clean))
      return "That would allow every command. Allow the command itself instead.";
  }
  return null;
}
