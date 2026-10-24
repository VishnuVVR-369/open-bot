/**
 * What a teammate asks you about. Purchases and emails always ask: no rule covers spending money
 * or writing to people as you.
 */
export type ApprovalKind = "command" | "file_change" | "action" | "purchase" | "email";

/** What an "always allow" rule can cover. */
export type RuleKind = Exclude<ApprovalKind, "purchase" | "email">;

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
      return relevant.some((rule) => normalize(rule.pattern) === normalize(text));
    case "purchase":
    case "email":
      return false;
  }
}

/** A sensible rule for a request: the first command's program and subcommand, or the action. */
export function suggestedRule(kind: ApprovalKind, subject: string): string {
  if (kind === "file_change" || kind === "purchase" || kind === "email") return "";
  if (kind === "action") return subject.trim();
  const script = shellScript(subject);
  const first = simpleCommands(script)?.[0] ?? script;
  return first.split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
}

/** Why a rule pattern can't be saved, or null when it can. */
export function invalidRulePattern(kind: ApprovalKind, pattern: string): string | null {
  if (kind === "file_change") return null;
  if (kind === "purchase")
    return "Purchases always ask you. Set an amount to approve on its own instead.";
  const clean = pattern.trim();
  if (!clean) return "Say what to allow.";
  if (kind === "command") {
    if (simpleCommands(clean)?.length !== 1) return "Allow one command, without ; && | or >.";
    if (SHELL_WRAPPER.test(`${clean} x`) || /^(?:\S*\/)?(?:ba|z)?sh$/.test(clean))
      return "That would allow every command. Allow the command itself instead.";
  }
  return null;
}
