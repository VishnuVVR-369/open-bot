#!/usr/bin/env node
// Fails when a Markdown or MDX file names a repo path that does not exist: inline code spans that
// start with apps/ or packages/, and relative Markdown links (inline and reference definitions).
// Code-span globs (`packages/*`) and placeholders (`apps/worker/src/accounts/<integration>.ts`)
// must match at least one path. Build output that .gitignore covers (`apps/worker/dist/worker.mjs`)
// counts as existing when the folder it is built in exists. Fenced code blocks are skipped.
// Needs only git and Node. Run from anywhere: `pnpm check:doc-paths`.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo-root paths in code spans start with one of these. */
const ROOTS = ["apps/", "packages/"];

/** A fence opens or closes a code block, after any blockquote or list container prefix. */
const FENCE = /^(?:\s{0,3}>)*\s*(`{3,}|~{3,})(.*)$/;

/**
 * The prose of a document, with fenced code blocks blanked out so line numbers stay true.
 * Fences inside blockquotes count, and a fence closes only on a line of the same character,
 * at least as long, with nothing after it.
 */
export function prose(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = line.match(FENCE);
      if (fence === null) {
        if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
          fence = marker[1];
          return "";
        }
        return line;
      }
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = null;
      }
      return "";
    })
    .join("\n");
}

const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * Code spans as CommonMark reads them: a run of backticks up to the next run of the same length,
 * possibly across lines. Returns each span's content and offset, and the text with spans blanked.
 */
export function codeSpans(text) {
  const spans = [];
  let rest = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      rest += text[i++];
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run++;
    const ticks = "`".repeat(run);
    let close = text.indexOf(ticks, i + run);
    // The closing run must be exactly as long: skip longer runs.
    while (close !== -1 && (text[close + run] === "`" || text[close - 1] === "`")) {
      let end = close;
      while (text[end] === "`") end++;
      close = text.indexOf(ticks, end);
    }
    if (close === -1) {
      rest += ticks;
      i += run;
      continue;
    }
    let content = text.slice(i + run, close).replace(/\n/g, " ");
    if (content.startsWith(" ") && content.endsWith(" ") && content.trim()) {
      content = content.slice(1, -1);
    }
    spans.push({ content, offset: i });
    rest += text.slice(i, close + run).replace(/[^\n]/g, " ");
    i = close + run;
  }
  return { spans, rest };
}

/** The destination of an inline link starting just after `](`, honoring <...> and nested parens. */
function destination(text, start) {
  let i = start;
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] === "<") {
    const end = text.indexOf(">", i + 1);
    return end === -1 ? null : text.slice(i + 1, end);
  }
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const char = text[j];
    if (char === "\\") j++;
    else if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(char)) break;
  }
  return j > i ? text.slice(i, j) : null;
}

/**
 * The paths a document names, with their 1-based line numbers: code spans rooted at apps/ or
 * packages/, and the targets of inline links and link reference definitions outside code.
 */
export function referencedPaths(text) {
  const visible = prose(text);
  const { spans, rest } = codeSpans(visible);
  const found = [];
  for (const { content, offset } of spans) {
    const candidate = codeSpanPath(content);
    if (candidate) found.push({ line: lineAt(visible, offset), path: candidate, kind: "code" });
  }
  for (const match of rest.matchAll(/\]\(/g)) {
    const target = destination(rest, match.index + 2);
    const candidate = target && linkPath(target);
    if (candidate) found.push({ line: lineAt(rest, match.index), path: candidate, kind: "link" });
  }
  for (const match of rest.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    const target = match[1].startsWith("<") ? match[1].slice(1, -1) : match[1];
    const candidate = linkPath(target);
    if (candidate) found.push({ line: lineAt(rest, match.index), path: candidate, kind: "link" });
  }
  return found.sort((a, b) => a.line - b.line);
}

/** A code span is a path when the whole span is one, rooted at apps/ or packages/. */
export function codeSpanPath(span) {
  const text = span.trim();
  if (!ROOTS.some((root) => text.startsWith(root))) return null;
  if (/\s/.test(text)) return null; // A command or prose, like `apps/web dev`.
  if (text.includes("...") || text.includes("…")) return null; // Elided, like `apps/...`.
  // `file.ts:12`, `file.ts:12-30` and `file.ts#L12` point into a file that must exist.
  return text.replace(/(?::\d+(?:[-,]\d+)*|#L?\d+)$/, "").replace(/\/$/, "");
}

/** A relative Markdown link to a file in the repo; URLs, site routes and anchors are not files. */
export function linkPath(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("#")) {
    return null;
  }
  const file = target.split("#")[0].split("?")[0];
  if (!file) return null;
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

/** Turns `<placeholder>` segments into wildcards, and escapes `[` so Next.js route folders stay literal. */
export function toGlob(reference) {
  return reference.replace(/<[^>]*>/g, "*").replace(/\[/g, "[[]");
}

const GLOB = /[*?{]|<[^>]*>/;

/**
 * Whether a referenced path exists. Code spans may be globs; links are always literal. A path
 * inside ignored build output exists when the folder holding that output does, so a typo in the
 * workspace part still fails.
 */
export function exists(root, reference, { ignored, literal = false }) {
  if (existsSync(path.join(root, reference))) return true;
  if (!literal && GLOB.test(reference)) {
    return globSync(toGlob(reference), { cwd: root }).length > 0;
  }
  const parts = reference.split("/");
  for (let end = 1; end <= parts.length; end++) {
    if (!ignored(parts.slice(0, end).join("/"))) continue;
    const parent = parts.slice(0, end - 1).join("/");
    return parent === "" || existsSync(path.join(root, parent));
  }
  return false;
}

/** Asks git whether a path is ignored, as a file or as a folder (for `dist/` style rules). */
function gitIgnored(root) {
  const cache = new Map();
  const check = (candidate) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", candidate], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  return (reference) => {
    if (!cache.has(reference)) cache.set(reference, check(reference) || check(`${reference}/`));
    return cache.get(reference);
  };
}

function documents(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md", "*.mdx"],
    { cwd: root, encoding: "utf8" },
  );
  return out
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)))
    .sort();
}

export function check(root) {
  const ignored = gitIgnored(root);
  const problems = [];
  for (const file of documents(root)) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const { line, path: reference, kind } of referencedPaths(text)) {
      const resolved =
        kind === "link"
          ? path.relative(root, path.resolve(root, path.dirname(file), reference))
          : reference;
      const inside = !resolved.startsWith("..") && !path.isAbsolute(resolved);
      if (!inside || !exists(root, resolved, { ignored, literal: kind === "link" })) {
        problems.push(`${file}:${line}: ${reference} does not exist`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const problems = check(root);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n\n${problems.length} missing path(s) in docs.\n`);
    process.exit(1);
  }
  process.stdout.write("Every path named in the docs exists.\n");
}
