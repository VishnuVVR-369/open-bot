#!/usr/bin/env node
// Keeps legacy vocabulary from spreading (see the glossary in the root AGENTS.md). Code still uses
// names like `botId` and `is_primary` that are renamed later; this check counts each banned term per
// file and fails when a file uses one more often than `vocabulary-baseline.json` allows, or when the
// baseline is higher than the code (run `pnpm check:vocabulary --update` after removing uses).
// `--update` refuses to raise a term's total across the repository, so moving a file works but a new
// use does not; `--allow-growth` is for reviewed changes only, such as a stricter rule.
// A line that must keep a banned word (a third-party API, say) can end with `vocabulary: allow`.
// Known limit: a two-word phrase split across lines ("desktop" ending one comment line and
// "takeover" starting the next) is not seen. Needs only git and Node.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isBot = (word) => word === "bot" || word === "bots";

/** Each rule matches the words of one identifier or phrase, already split and lowercased. */
export const RULES = [
  {
    term: "bot",
    use: "teammate",
    matches: (words) => words.some(isBot),
  },
  {
    term: "primary teammate",
    use: "lead",
    matches: (words, token) =>
      /^(isPrimary|is_primary|IS_PRIMARY)$/.test(token) ||
      /^set_?primary/i.test(token) ||
      words.some((word, i) => word === "primary" && isBot(words[i + 1] ?? "")),
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
  /\/home\/bot\b/g, // The computer's Linux user.
  /\bbot user\b/gi,
  /\bbot:bot\b/g,
  /\bbot(User|Group|Processes)\b/g, // botd's names for that user, its group and its processes.
  /`bots` group|\bBOTS_GID\b/g, // The Linux group both computer users share.
  /\bBotFather\b/g, // Telegram's own name.
];

/** An identifier, or a hyphenated word like `open-bot` or `desktop-takeover`; Unicode-aware. */
const TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*(?:-[\p{L}\p{N}_$]+)*/gu;

/** Code files only: docs prose and the database's migration history are out of scope. */
const INCLUDE = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.kt"];
const EXCLUDE = [
  /^packages\/agent\/src\/protocol\//, // Generated.
  /^packages\/db\/drizzle\//, // Shipped migrations are never edited.
  /^apps\/mobile\/src\/computer\/viewer-html\.ts$/, // Generated.
  /^apps\/web\/src\/components\/ui\//, // shadcn.
  /^scripts\/check\/vocabulary(\.test)?\.mjs$/, // Names the terms on purpose.
  /^packages\/db\/src\/owners\.ts$/, // Names tables and files as they are named today.
];

export const BASELINE = "scripts/check/vocabulary-baseline.json";

/** Test doubles for outside services are stand-ins, in `e2e/stand-ins/`: never named `mock` or `fake`. */
export const STAND_IN = { term: "mock (test double)", use: "stand-in" };
export function standInName(file) {
  return /^e2e\//.test(file) && /(mock|fake)/i.test(path.basename(file));
}

/**
 * `botId` -> ["bot", "id"], `BOT2_ID` -> ["bot", "2", "id"], `HTTPBotClient` -> ["http", "bot",
 * "client"]. The product's name stays one word: `openBotDesktop` -> ["open-bot", "desktop"], while
 * `reopenBot` -> ["reopen", "bot"].
 */
export function words(token) {
  const split = token
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .split(/[\s_$-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const out = [];
  for (const word of split) {
    if (word === "bot" && out.at(-1) === "open") out[out.length - 1] = "open-bot";
    else out.push(word);
  }
  return out;
}

/**
 * The banned terms in one file's text, with the lines they are on. Each identifier is checked on
 * its own, and so is each pair of words separated only by spaces, so prose such as "desktop
 * takeover" counts once without counting a single word twice.
 */
export function findTerms(text) {
  const found = [];
  text.split("\n").forEach((raw, index) => {
    if (/vocabulary: allow\b/.test(raw)) return;
    let line = raw;
    for (const pattern of NOT_VOCABULARY) line = line.replace(pattern, " ");
    let previous = null;
    for (const match of line.matchAll(TOKEN)) {
      const token = match[0];
      const split = words(token);
      for (const rule of RULES) {
        if (rule.matches(split, token)) found.push({ term: rule.term, line: index + 1, token });
      }
      if (previous && /^[ \t]+$/.test(line.slice(previous.end, match.index))) {
        const last = previous.words.at(-1);
        const first = split[0];
        for (const rule of RULES) {
          if (
            rule.matches([last, first], "") &&
            !rule.matches([last], "") &&
            !rule.matches([first], "")
          ) {
            found.push({ term: rule.term, line: index + 1, token: `${previous.token} ${token}` });
          }
        }
      }
      previous = { token, words: split, end: match.index + token.length };
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

/** `{ file: { term: count } }` for every tracked or untracked, not ignored, file that uses a banned term. */
export function measure(root) {
  const result = {};
  for (const file of files(root)) {
    const counts = countTerms(readFileSync(path.join(root, file), "utf8"));
    if (standInName(file)) counts[STAND_IN.term] = 1;
    if (Object.keys(counts).length > 0) result[file] = counts;
  }
  return result;
}

const MAX_LINES = 8;

/** Where to look: the lines when there are few, otherwise how to list them. */
function where(file, lines) {
  if (lines.length === 0) return "Rename the file.";
  if (lines.length <= MAX_LINES) return `Lines: ${lines.join(", ")}`;
  return `List them with pnpm check:vocabulary --show ${file}`;
}

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

function totals(result) {
  const sums = {};
  for (const counts of Object.values(result)) {
    for (const [term, count] of Object.entries(counts)) sums[term] = (sums[term] ?? 0) + count;
  }
  return sums;
}

/** Terms whose repository-wide total would rise if the baseline became `actual`. */
export function growth(actual, baseline) {
  const before = totals(baseline);
  return Object.entries(totals(actual))
    .filter(([term, count]) => count > (before[term] ?? 0))
    .map(([term, count]) => `"${term}" ${before[term] ?? 0} -> ${count}`);
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

function main(argv) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const baselinePath = path.join(root, BASELINE);
  const readBaseline = () =>
    existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};

  const show = argv.indexOf("--show");
  if (show >= 0) {
    const file = argv[show + 1];
    if (!file || !existsSync(file)) {
      process.stderr.write("Usage: pnpm check:vocabulary --show <file>\n");
      return 2;
    }
    for (const found of findTerms(readFileSync(file, "utf8"))) {
      process.stdout.write(`${file}:${found.line}: ${found.token} (${found.term})\n`);
    }
    return 0;
  }

  const actual = measure(root);
  if (argv.includes("--update")) {
    const grown = growth(actual, readBaseline());
    if (grown.length > 0 && !argv.includes("--allow-growth")) {
      process.stderr.write(
        `Not updating ${BASELINE}: legacy uses would grow (${grown.join(", ")}).\n` +
          "Use the canonical terms in new code. Pass --allow-growth only for a reviewed change, such as a stricter rule.\n",
      );
      return 1;
    }
    writeFileSync(baselinePath, `${JSON.stringify(sorted(actual), null, 2)}\n`);
    process.stdout.write(`Wrote ${BASELINE}. Review the diff before committing it.\n`);
    return 0;
  }

  const problems = compare(actual, readBaseline(), (file) =>
    readFileSync(path.join(root, file), "utf8"),
  );
  if (problems.length > 0) {
    process.stderr.write(
      `${problems.join("\n")}\n\nSee the glossary in AGENTS.md for the canonical terms.\n`,
    );
    return 1;
  }
  const total = Object.values(totals(actual)).reduce((a, b) => a + b, 0);
  process.stdout.write(`No new legacy vocabulary (${total} legacy uses left to rename).\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
