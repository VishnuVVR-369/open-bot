#!/usr/bin/env node
// Fails when a Markdown or MDX file names a repo path that does not exist: inline code spans that
// start with apps/ or packages/, and relative Markdown links. Globs (`packages/*`) and
// placeholders (`apps/worker/src/accounts/<integration>.ts`) must match at least one path.
// Build output that .gitignore covers (`apps/worker/dist/worker.mjs`) counts as existing.
// Needs only git and Node. Run from anywhere: `pnpm check:doc-paths`.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo-root paths in code spans start with one of these. */
const ROOTS = ["apps/", "packages/"];

/**
 * The paths a document names, with their 1-based line numbers. Fenced code blocks are skipped:
 * they hold commands and sample output, not references.
 */
export function referencedPaths(text) {
  const found = [];
  let fence = null;
  text.split("\n").forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1].startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) return;
    for (const [, span] of line.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) {
      const candidate = codeSpanPath(span);
      if (candidate) found.push({ line: index + 1, path: candidate, kind: "code" });
    }
    for (const [, target] of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const candidate = linkPath(target);
      if (candidate) found.push({ line: index + 1, path: candidate, kind: "link" });
    }
  });
  return found;
}

/** A code span is a path when the whole span is one, rooted at apps/ or packages/. */
export function codeSpanPath(span) {
  const text = span.trim();
  if (!ROOTS.some((root) => text.startsWith(root))) return null;
  if (/\s/.test(text)) return null; // A command or prose, like `apps/web dev`.
  if (text.includes("...") || text.includes("\u2026")) return null; // Elided, like `apps/...`.
  // `file.ts:12`, `file.ts:12-30` and `file.ts#L12` point into a file that must exist.
  return text.replace(/(?::\d+(?:[-,]\d+)*|#L?\d+)$/, "").replace(/\/$/, "");
}

/** A relative Markdown link to a file in the repo; URLs, site routes and anchors are not files. */
export function linkPath(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("#")) {
    return null;
  }
  const file = target.split("#")[0];
  return file ? decodeURIComponent(file) : null;
}

/** Turns `<placeholder>` segments into wildcards, and escapes `[` so Next.js route folders stay literal. */
export function toGlob(reference) {
  return reference.replace(/<[^>]*>/g, "*").replace(/\[/g, "[[]");
}

const GLOB = /[*?{]|<[^>]*>/;

export function exists(root, reference, ignored) {
  if (existsSync(path.join(root, reference))) return true;
  if (GLOB.test(reference)) return globSync(toGlob(reference), { cwd: root }).length > 0;
  return ignored(reference);
}

function gitIgnored(root) {
  return (reference) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", reference], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
}

function documents(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md", "*.mdx"],
    { cwd: root, encoding: "utf8" },
  );
  return out.split("\0").filter((file) => file && existsSync(path.join(root, file)));
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
      if (resolved.startsWith("..") || !exists(root, resolved, ignored)) {
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
