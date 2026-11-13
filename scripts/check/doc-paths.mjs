#!/usr/bin/env node
// Fails when a Markdown or MDX file names a repo path that does not exist: inline code spans that
// start with a top-level code folder (apps/, packages/, e2e/, scripts/, ...), and relative link,
// image and link reference definition targets.
// Code-span globs (`packages/*`) and placeholders (`apps/worker/src/accounts/<integration>.ts`)
// must match at least one path. Build output that .gitignore covers (`apps/worker/dist/worker.mjs`)
// counts as existing when the folder it is built in exists. Documents are parsed the way the site
// renders them (CommonMark with GFM, plus MDX for .mdx), so code blocks, containers and escapes
// follow the spec. Needs git, Node and the root dev dependencies. Run: `pnpm check:doc-paths`.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { gfm } from "micromark-extension-gfm";
import { mdxjs } from "micromark-extension-mdxjs";

/**
 * Repo-root paths in code spans start with one of these. A path inside an app is written from the
 * repo root too (`apps/mobile/scripts/build-viewer.mjs`), so `scripts/x.mjs` means the root's.
 */
const ROOTS = ["apps/", "packages/", "e2e/", "scripts/", "images/", "tools/", ".railway/"];

/** The syntax tree of a document: GFM always, MDX for .mdx files. Throws on invalid MDX. */
export function parse(text, { mdx = false } = {}) {
  return fromMarkdown(text, {
    extensions: mdx ? [gfm(), mdxjs()] : [gfm()],
    mdastExtensions: mdx ? [gfmFromMarkdown(), mdxFromMarkdown()] : [gfmFromMarkdown()],
  });
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * The paths a document names, with their 1-based line numbers: inline code spans rooted at apps/
 * or packages/, and the targets of links, images and link reference definitions. Code blocks are
 * not prose and are skipped.
 */
export function referencedPaths(text, options) {
  const found = [];
  walk(parse(text, options), (node) => {
    const line = node.position?.start.line;
    if (node.type === "inlineCode") {
      const candidate = codeSpanPath(node.value);
      if (candidate) found.push({ line, path: candidate, kind: "code" });
    } else if (node.type === "link" || node.type === "image" || node.type === "definition") {
      const candidate = linkPath(node.url);
      if (candidate) found.push({ line, path: candidate, kind: "link" });
    }
  });
  return found.sort((a, b) => a.line - b.line);
}

/** A code span is a path when the whole span is one, rooted at a folder in ROOTS. */
export function codeSpanPath(span) {
  const text = span.replace(/\n/g, " ").trim();
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

/** Where a parse error is: its own line, its range's start, or the `(3:1-3:7)` in its message. */
export function errorLine(error) {
  const fromReason = /\((\d+):\d+(?:-\d+:\d+)?\)/.exec(error.reason ?? "");
  return error.line ?? error.place?.start?.line ?? (fromReason ? Number(fromReason[1]) : 1);
}

export function check(root) {
  const ignored = gitIgnored(root);
  const problems = [];
  for (const file of documents(root)) {
    const text = readFileSync(path.join(root, file), "utf8");
    let references;
    try {
      references = referencedPaths(text, { mdx: file.endsWith(".mdx") });
    } catch (error) {
      problems.push(
        `${file}:${errorLine(error)}: cannot be parsed: ${error.reason ?? error.message}`,
      );
      continue;
    }
    for (const { line, path: reference, kind } of references) {
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
