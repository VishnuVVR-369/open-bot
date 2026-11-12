#!/usr/bin/env node
// Keeps source files small enough to read in one sitting. Each code file in apps/* and packages/*
// gets a budget of lines of code (blank lines and comments not counted): a target of 400 and a
// limit of 600. A file over the limit fails, unless `file-size-baseline.json` records it from
// before the limit existed; such a file may shrink but never grow, and the baseline must follow it
// down (`pnpm check:file-size --update`). `--update` refuses to let a file grow, or the number or
// total size of the files over the limit rise; moving or renaming a file works.
// `--allow-growth` is for reviewed changes only. `--report` lists every file over the target,
// which is reported, never enforced. Generated code is skipped. Needs git, Node and `typescript`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readBaseline, repoRoot, writeBaseline } from "./baseline.mjs";
import { codeFiles } from "./import-graph.mjs";

export const TARGET = 400;
export const LIMIT = 600;
export const BASELINE = "scripts/check/file-size-baseline.json";
export const FOLDERS = ["apps", "packages"];

const SCRIPT_KIND = {
  ".tsx": ts.ScriptKind.TSX,
  ".jsx": ts.ScriptKind.JSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

/**
 * Lines that hold code: a line counts when any token other than a comment touches it. Parsing
 * (rather than matching `//`) keeps "https://" in a string or JSX text from looking like a comment,
 * and counts every line of a multi-line string or template.
 */
export function linesOfCode(text, fileName = "file.ts") {
  const kind = SCRIPT_KIND[path.extname(fileName)] ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    fileName,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    kind,
  );
  const lines = new Set();
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line;
  const visit = (node) => {
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    if (node.kind === ts.SyntaxKind.JsxText) {
      // JSX text keeps its own whitespace and newlines; only lines with words are code.
      node.text.split("\n").forEach((line, i) => {
        if (line.trim()) lines.add(lineOf(node.pos) + i);
      });
      return;
    }
    const start = node.getStart(source);
    if (node.end <= start) return;
    for (let line = lineOf(start); line <= lineOf(node.end - 1); line++) lines.add(line);
  };
  visit(source);
  return lines.size;
}

/** `{ file: linesOfCode }` for every code file in apps/* and packages/*, generated code skipped. */
export function measure(root) {
  const result = {};
  for (const file of codeFiles(root, FOLDERS)) {
    result[file] = linesOfCode(readFileSync(path.join(root, file), "utf8"), file);
  }
  return result;
}

/** The files over the limit, as the baseline records them. */
export function overLimit(sizes) {
  return Object.fromEntries(
    Object.keys(sizes)
      .filter((file) => sizes[file] > LIMIT)
      .sort()
      .map((file) => [file, sizes[file]]),
  );
}

const SPLIT =
  "Split it: move a part that stands on its own (a component, a group of handlers, a set of helpers) into a new file beside it and import it.";

/** Compares the code with the baseline; returns problems for the developer to fix. */
export function compare(sizes, baseline) {
  const problems = [];
  for (const [file, lines] of Object.entries(sizes)) {
    const allowed = baseline[file];
    if (allowed === undefined) {
      if (lines > LIMIT) {
        problems.push(
          `${file}: ${lines} lines of code, over the limit of ${LIMIT} (blank lines and comments are not counted). ${SPLIT} Aim for ${TARGET} or fewer. If you only moved or renamed a file the baseline already lists, run pnpm check:file-size --update.`,
        );
      }
    } else if (lines > allowed) {
      problems.push(
        `${file}: ${lines} lines of code. It is over the limit of ${LIMIT}, and the baseline lets it keep ${allowed} until it is split, but not grow. Put the new code in a new file, or move code out of this one first. ${SPLIT}`,
      );
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const lines = sizes[file];
    if (lines === undefined || lines < allowed) {
      const now = lines === undefined ? "the file is gone" : `it has ${lines}`;
      problems.push(
        `${file}: the baseline allows ${allowed} lines of code but ${now}. Run pnpm check:file-size --update to lock in the smaller size, and commit ${BASELINE}.`,
      );
    }
  }
  return problems;
}

const total = (baseline) => Object.values(baseline).reduce((sum, lines) => sum + lines, 0);

/** Why the baseline may not become `next`: a file grew, or the debt rose in count or lines. */
export function growth(next, baseline) {
  const grown = Object.entries(next)
    .filter(([file, lines]) => baseline[file] !== undefined && lines > baseline[file])
    .map(([file, lines]) => `${file} ${baseline[file]} -> ${lines}`);
  const before = Object.keys(baseline).length;
  const after = Object.keys(next).length;
  if (after > before) grown.push(`files over the limit ${before} -> ${after}`);
  if (total(next) > total(baseline)) {
    grown.push(`lines in files over the limit ${total(baseline)} -> ${total(next)}`);
  }
  return grown;
}

function main(argv) {
  const root = repoRoot();
  const baseline = readBaseline(root, BASELINE, {});
  const sizes = measure(root);
  const over = overLimit(sizes);

  if (argv.includes("--report")) {
    const above = Object.entries(sizes)
      .filter(([, lines]) => lines > TARGET)
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
    for (const [file, lines] of above) {
      process.stdout.write(
        `${String(lines).padStart(5)}  ${file}${lines > LIMIT ? "  (over the limit)" : ""}\n`,
      );
    }
    process.stdout.write(`${above.length} files over the target of ${TARGET} lines of code.\n`);
    return 0;
  }

  if (argv.includes("--update")) {
    const grown = growth(over, baseline);
    if (grown.length > 0 && !argv.includes("--allow-growth")) {
      process.stderr.write(
        `Not updating ${BASELINE}: it would grow (${grown.join(", ")}).\n` +
          `Split files instead; run pnpm check:file-size to see which. Pass --allow-growth only for a reviewed change.\n`,
      );
      return 1;
    }
    writeBaseline(root, BASELINE, over);
    process.stdout.write(`Wrote ${BASELINE}. Review the diff before committing it.\n`);
    return 0;
  }

  const problems = compare(sizes, baseline);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  const aboveTarget = Object.values(sizes).filter((lines) => lines > TARGET).length;
  process.stdout.write(
    `File sizes are within budget: ${Object.keys(over).length} files over the ${LIMIT}-line limit are baselined, ` +
      `${aboveTarget} are over the ${TARGET}-line target (pnpm check:file-size --report lists them).\n`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
