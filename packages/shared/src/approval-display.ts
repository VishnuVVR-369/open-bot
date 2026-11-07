import { shellScript, simpleCommands } from "./approval-rules";

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

/** The last part of a path, so a summary names the thing rather than where it lives. */
function lastSegment(path: string): string {
  const trimmed = path.replace(/^["']|["']$/g, "").replace(/\/+$/, "");
  const segment = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  return segment === "*" ? (trimmed.split("/").filter(Boolean).at(-2) ?? trimmed) : segment;
}

/** The words of a command, without flags (and their values, for the flags given). */
function operands(words: string[], valued: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (valued.includes(word)) i++;
    else if (!word.startsWith("-")) out.push(word);
  }
  return out;
}

function summarizeOne(command: string): string | null {
  const all = command.trim().split(/\s+/).filter(Boolean);
  // Redirections say where output goes, not what the command does.
  const cut = all.findIndex((word) => /^(\d?[<>]|&>)/.test(word));
  const words = cut < 0 ? all : all.slice(0, cut);
  while (words[0] === "sudo" || /^[A-Z_][A-Z0-9_]*=/.test(words[0] ?? "")) words.shift();
  const [tool, sub, ...rest] = words;
  if (!tool) return null;
  const args = operands(rest);
  switch (tool) {
    case "git":
      if (sub === "push") {
        const [, branch] = args;
        return branch ? `Push the ${branch} branch` : "Push to the remote";
      }
      if (sub === "commit") return "Commit changes";
      if (sub === "clone")
        return args[0]
          ? `Clone ${lastSegment(args[0]).replace(/\.git$/, "")}`
          : "Clone a repository";
      if (sub === "checkout" || sub === "switch")
        return args[0] ? `Switch to ${args[0]}` : "Switch branches";
      if (sub === "reset") return "Reset the branch";
      if (sub === "status") return "Check what changed";
      if (sub === "diff" || sub === "show") return "Look at changes";
      if (sub === "log") return "Read the history";
      if (sub === "merge") return args[0] ? `Merge ${args[0]}` : "Merge a branch";
      return sub ? `Run git ${sub}` : "Run git";
    case "gh": {
      const action = rest[0];
      if (sub === "pr") {
        if (action === "merge") return "Merge a pull request";
        if (action === "create") return "Open a pull request";
        if (action === "list") return "List pull requests";
        if (action === "close") return "Close a pull request";
        return "Look at a pull request";
      }
      if (sub === "issue") {
        if (action === "create") return "Open an issue";
        if (action === "list") return "List issues";
        if (action === "close") return "Close an issue";
        return "Look at an issue";
      }
      if (sub === "release") return action === "list" ? "List releases" : "Publish a release";
      if (sub === "run" || sub === "workflow") return "Check CI runs";
      return "Use GitHub";
    }
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "nl":
    case "wc": {
      const file = operands([sub ?? "", ...rest].filter(Boolean), ["-n", "-c"]).at(-1);
      return file ? `Read ${lastSegment(file)}` : "Read a file";
    }
    case "sed": {
      const all = [sub ?? "", ...rest].filter(Boolean);
      // The script comes first; the file it reads or edits is last.
      const file = operands(all, ["-e", "-f"])
        .slice(all.includes("-e") ? 0 : 1)
        .at(-1);
      const editing = all.some((word) => /^-i/.test(word) || word === "--in-place");
      if (editing) return file ? `Edit ${lastSegment(file)}` : "Edit a file";
      return file ? `Read ${lastSegment(file)}` : "Read a file";
    }
    case "ls":
    case "tree":
      return "List files";
    case "find":
    case "fd":
      return "Find files";
    case "grep":
    case "rg":
    case "ag":
      return "Search files";
    case "rm":
    case "rmdir":
    case "shred": {
      const targets = operands([sub ?? "", ...rest].filter(Boolean));
      if (targets.length === 0) return "Delete files";
      return targets.length === 1
        ? `Delete ${lastSegment(targets[0]!)}`
        : `Delete ${targets.length} items`;
    }
    case "mv":
      return "Move files";
    case "cp":
      return "Copy files";
    case "mkdir":
      return "Create a folder";
    case "chmod":
    case "chown":
      return "Change file permissions";
    case "pg_dump": {
      const database = operands([sub ?? "", ...rest].filter(Boolean), [
        "-f",
        "--file",
        "-U",
        "-h",
        "-p",
        "-t",
        "-n",
      ]).at(-1);
      return database ? `Export the ${database} database` : "Export a database";
    }
    case "psql":
    case "mysql":
    case "sqlite3":
      return "Run a database query";
    case "curl":
    case "wget":
      return "Make a web request";
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (sub === "install" || sub === "i" || sub === "add") return "Install packages";
      if (sub === "publish") return "Publish a package";
      return sub ? `Run ${sub === "run" ? (args[0] ?? "a script") : sub}` : `Run ${tool}`;
    case "docker":
      return "Run a container command";
    case "ssh":
      return "Connect to another machine";
    case "kill":
    case "pkill":
    case "killall":
      return "Stop a process";
    default:
      return `Run ${lastSegment(tool)}`;
  }
}

/**
 * A few plain words for what a shell command does, for a title: "Push the fix branch",
 * "Delete downloads". Follows the first command of a script and says how many more follow.
 * The command itself is still shown, in a code face, beside it.
 */
export function commandSummary(command: string): string {
  const script = shellScript(command);
  const parts = simpleCommands(script) ?? [script.split(/[;&|\n]/)[0] ?? script];
  const meaningful = parts.filter(
    (part) => !/^(cd|export|set|source|\.)\s/.test(part) && part !== "cd",
  );
  const first = meaningful[0] ?? parts[0] ?? script;
  const summary = summarizeOne(first) ?? "Run a command";
  const more = meaningful.length - 1;
  return more > 0 ? `${summary}, then ${more} more` : summary;
}

/**
 * The whole command a command approval runs: the "$ " line of its detail, else its title
 * (bare, or as the worker writes it, "Run `...`"). Null for approvals that aren't commands.
 */
export function approvalCommand(approval: ApprovalFacts): string | null {
  if (approval.kind !== "command") return null;
  const fromDetail = commandParts(approval.detail).command;
  if (fromDetail) return fromDetail;
  const title = approval.title.trim();
  const wrapped = /^Run `([\s\S]+)`$/.exec(title)?.[1] ?? title.replace(/^`([\s\S]*)`$/, "$1");
  const fromTitle = shellScript(wrapped);
  if (fromTitle) return fromTitle;
  return approval.subject ? shellScript(approval.subject) || null : null;
}

/**
 * What an approval leads with: plain words for a command ("Push the fix/x branch") with the
 * command itself beside it, in a code face; any other approval's own title.
 */
export function approvalHeadline(approval: ApprovalFacts): {
  title: string;
  command: string | null;
} {
  const command = approvalCommand(approval);
  return command
    ? { title: commandSummary(command), command }
    : { title: approval.title, command: null };
}
