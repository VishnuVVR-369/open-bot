#!/usr/bin/env node
// Keeps legacy vocabulary from spreading (see the glossary in the root AGENTS.md). Code still uses
// names like `botId` and `isPrimary` that are renamed later; this check counts each banned term per
// file and fails when a file uses one more often than `vocabulary-baseline.json` allows, or when the
// baseline is higher than the code (run `pnpm check:vocabulary --update` after removing uses).
// A line that must keep a banned word (a third-party API, say) can end with `vocabulary: allow`.
// Needs only git and Node.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Each rule matches the words of one identifier, already split and lowercased. */
export const RULES = [
  {
    term: "bot",
    use: "teammate",
    matches: (words) => words.includes("bot") || words.includes("bots"),
  },
  {
    term: "primary teammate",
    use: "lead",
    matches: (words, token) =>
      /^(isPrimary|is_primary|IS_PRIMARY)$/.test(token) ||
      (words.includes("primary") && (words.includes("bot") || words.includes("bots"))) ||
      (words[0] === "set" && words[1] === "primary"),
  },
  {
    term: "desktop takeover",
    use: "screen takeover",
    matches: (words) =>
      words.some((word, i) => word === "desktop" && /^takeovers?$/.test(words[i + 1] ?? "")),
  },
];

/** Text that contains a banned word but means something else, removed before matching. */
const NOT_VOCABULARY = [
  /open[-_]?bot/gi, // The product: open-bot, @open-bot/*, OPEN_BOT_*, openBotDesktop.
  /\/home\/bot\b/g, // The computer's Linux user.
  /\bbot user\b/gi,
  /\bbot:bot\b/g,
  /BotFather/g, // Telegram's own name.
];

/** Code files only: docs prose and the database's migration history are out of scope. */
const INCLUDE = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.kt"];
const EXCLUDE = [
  /^packages\/agent\/src\/protocol\//, // Generated.
  /^packages\/db\/drizzle\//, // Shipped migrations are never edited.
  /^apps\/mobile\/src\/computer\/viewer-html\.ts$/, // Generated.
  /^apps\/web\/src\/components\/ui\//, // shadcn.
  /^scripts\/check\/vocabulary(\.test)?\.mjs$/, // Names the terms on purpose.
];

export const BASELINE = "scripts/check/vocabulary-baseline.json";

/** Test doubles for outside services are stand-ins: `e2e/accounts-stand-in.ts`, not `-mock` or `-fake`. */
export const STAND_IN = { term: "mock (test double)", use: "stand-in" };
export function standInName(file) {
  return /^e2e\//.test(file) && /(mock|fake)/i.test(path.basename(file));
}

/** `botId` -> ["bot", "id"], `BOT_ID` -> ["bot", "id"], `BotSummary` -> ["bot", "summary"]. */
export function words(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** The banned terms in one file's text, with the lines they are on. */
export function findTerms(text) {
  const found = [];
  text.split("\n").forEach((raw, index) => {
    if (/vocabulary: allow\b/.test(raw)) return;
    let line = raw;
    for (const pattern of NOT_VOCABULARY) line = line.replace(pattern, " ");
    for (const [token] of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const split = words(token);
      for (const rule of RULES) {
        if (rule.matches(split, token)) found.push({ term: rule.term, line: index + 1, token });
      }
    }
  });
  return found;
}

export function countTerms(text) {
  const counts = {};
  for (const { term } of findTerms(text)) counts[term] = (counts[term] ?? 0) + 1;
  return counts;
}

function files(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...INCLUDE],
    { cwd: root, encoding: "utf8" },
  );
  return out
    .split("\0")
    .filter((file) => file && !EXCLUDE.some((pattern) => pattern.test(file)))
    .filter((file) => existsSync(path.join(root, file)))
    .sort();
}

/** `{ file: { term: count } }` for every file that uses a banned term. */
export function measure(root) {
  const result = {};
  for (const file of files(root)) {
    const counts = countTerms(readFileSync(path.join(root, file), "utf8"));
    if (standInName(file)) counts[STAND_IN.term] = 1;
    if (Object.keys(counts).length > 0) result[file] = counts;
  }
  return result;
}

/** Where to look: the lines when there are few, otherwise how to list them. */
function where(file, lines) {
  if (lines.length === 0) return "Rename the file.";
  if (lines.length <= MAX_LINES) return `Lines: ${lines.join(", ")}`;
  return `List them with pnpm check:vocabulary --show ${file}`;
}

const MAX_LINES = 8;

/** Compares the code with the baseline; returns problems for the developer to fix. */
export function compare(actual, baseline, readFile) {
  const problems = [];
  const use = (term) => [...RULES, STAND_IN].find((rule) => rule.term === term)?.use;
  for (const [file, counts] of Object.entries(actual)) {
    for (const [term, count] of Object.entries(counts)) {
      const allowed = baseline[file]?.[term] ?? 0;
      if (count <= allowed) continue;
      const lines = findTerms(term === STAND_IN.term ? "" : readFile(file))
        .filter((found) => found.term === term)
        .map((found) => `${found.line} (${found.token})`);
      problems.push(
        `${file}: ${count} uses of "${term}", ${allowed} allowed. New code says "${use(term)}". ${where(file, lines)}`,
      );
    }
  }
  for (const [file, counts] of Object.entries(baseline)) {
    for (const [term, allowed] of Object.entries(counts)) {
      const count = actual[file]?.[term] ?? 0;
      if (count < allowed) {
        problems.push(
          `${file}: the baseline allows ${allowed} uses of "${term}" but there are ${count}. Run pnpm check:vocabulary --update.`,
        );
      }
    }
  }
  return problems;
}

function sorted(result) {
  return Object.fromEntries(
    Object.keys(result)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(result[file])
            .sort()
            .map((t) => [t, result[file][t]]),
        ),
      ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const actual = measure(root);
  const baselinePath = path.join(root, BASELINE);
  if (process.argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(sorted(actual), null, 2)}\n`);
    process.stdout.write(`Wrote ${BASELINE}. Review the diff: it should only shrink.\n`);
    process.exit(0);
  }
  const show = process.argv.indexOf("--show");
  if (show >= 0) {
    const file = process.argv[show + 1] ?? "";
    for (const found of findTerms(readFileSync(path.resolve(file), "utf8"))) {
      process.stdout.write(`${file}:${found.line}: ${found.token} (${found.term})\n`);
    }
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const problems = compare(actual, baseline, (file) => readFileSync(path.join(root, file), "utf8"));
  if (problems.length > 0) {
    process.stderr.write(
      `${problems.join("\n")}\n\nSee the glossary in AGENTS.md for the canonical terms.\n`,
    );
    process.exit(1);
  }
  const total = Object.values(actual).reduce(
    (sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0),
    0,
  );
  process.stdout.write(`No new legacy vocabulary (${total} legacy uses left to rename).\n`);
}
