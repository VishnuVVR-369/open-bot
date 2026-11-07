// Unit tests for the doc path check (scripts/check/doc-paths.mjs): `pnpm test:scripts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { check, codeSpanPath, linkPath, prose, referencedPaths, toGlob } from "./doc-paths.mjs";

const paths = (text) => referencedPaths(text).map((found) => `${found.line}:${found.path}`);

describe("referencedPaths", () => {
  it("finds code spans rooted at apps/ or packages/, with line numbers", () => {
    const text = "See `apps/web/src/app` and `packages/db`.\nNot `src/index.ts` or `pnpm test`.";
    assert.deepEqual(paths(text), ["1:apps/web/src/app", "1:packages/db"]);
  });

  it("reads double-backtick spans, spans across lines and spans in tables", () => {
    const text = [
      "``apps/double.ts`` and `` `apps/padded.ts` ``",
      "a `",
      "apps/multi.ts",
      "` span",
      "| `packages/in-table.ts` | x |",
    ].join("\n");
    assert.deepEqual(paths(text), [
      "1:apps/double.ts",
      "2:apps/multi.ts",
      "5:packages/in-table.ts",
    ]);
  });

  it("drops a span broken mid-path, because its content then has a space", () => {
    assert.deepEqual(paths("`apps/split\n/file.ts`"), []);
  });
  it("does not treat a lone backtick as a span opener", () => {
    assert.deepEqual(paths("a ` stray, then `apps/real.ts`"), []);
  });

  it("finds inline links with parentheses, angle brackets, and single- or double-quoted titles", () => {
    const text = [
      "[page](apps/web/src/app/(app)/bots/page.tsx)",
      "[angled](<my file.md>) [titled](a.md 'Title') [quoted](b.md \"Title\")",
    ].join("\n");
    assert.deepEqual(paths(text), [
      "1:apps/web/src/app/(app)/bots/page.tsx",
      "2:my file.md",
      "2:a.md",
      "2:b.md",
    ]);
  });

  it("finds link reference definitions", () => {
    assert.deepEqual(paths("[ref]: ./guide.md\n[url]: https://example.com\n[angle]: <x y.md>"), [
      "1:./guide.md",
      "3:x y.md",
    ]);
  });

  it("skips URLs, site routes, anchors, and links written inside code", () => {
    const text = "[b](https://x.dev) [c](/docs/flows) [d](#top) [e](mailto:a@b.c) `[f](gone.md)`";
    assert.deepEqual(paths(text), []);
  });
});

describe("prose", () => {
  it("blanks fenced blocks, including longer and tilde fences", () => {
    const text = ["```sh", "`apps/a`", "```", "````md", "```", "`apps/b`", "````", "`apps/c`"];
    assert.deepEqual(paths(text.join("\n")), ["8:apps/c"]);
  });

  it("does not close a fence on a line with an info string", () => {
    const text = ["~~~", "~~~javascript", "`apps/inside`", "~~~", "`apps/after`"].join("\n");
    assert.deepEqual(paths(text), ["5:apps/after"]);
  });

  it("recognizes fences inside blockquotes", () => {
    const text = ["> ```sh", "> cat `apps/inside`", "> ```", "`apps/after`"].join("\n");
    assert.deepEqual(paths(text), ["4:apps/after"]);
  });

  it("keeps line numbers", () => {
    assert.equal(prose("a\n```\nb\n```\nc").split("\n").length, 5);
  });
});

describe("codeSpanPath", () => {
  it("strips line references and a trailing slash", () => {
    assert.equal(codeSpanPath("apps/worker/src/http.ts:871"), "apps/worker/src/http.ts");
    assert.equal(codeSpanPath("apps/worker/src/http.ts:222-837"), "apps/worker/src/http.ts");
    assert.equal(codeSpanPath("packages/shared/"), "packages/shared");
  });

  it("ignores commands, other roots and elided paths", () => {
    assert.equal(codeSpanPath("node apps/worker/dist/worker.mjs"), null);
    assert.equal(codeSpanPath("docs/README.md"), null);
    assert.equal(codeSpanPath("apps/..."), null);
  });
});

describe("linkPath", () => {
  it("decodes the file part of a link", () => {
    assert.equal(linkPath("my%20file.md#x"), "my file.md");
  });
});

describe("toGlob", () => {
  it("turns placeholders into wildcards and keeps route folders literal", () => {
    assert.equal(
      toGlob("apps/web/src/app/(app)/bots/[botId]/<x>.tsx"),
      "apps/web/src/app/(app)/bots/[[]botId]/*.tsx",
    );
  });
});

describe("check", () => {
  let root;
  const write = (file, content = "") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root });

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "doc-paths-"));
    git("init", "-q");
    write("apps/web/src/app/(app)/[id]/page.tsx");
    write("apps/worker/src/index.ts");
    write("packages/db/schema.ts");
    write(".gitignore", "dist/\nrelease/\n");
    write("other.md");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** Writes one tracked and one untracked document, so both kinds are checked. */
  const problems = (tracked, untracked = "") => {
    write("TRACKED.md", tracked);
    git("add", "TRACKED.md");
    write("UNTRACKED.md", untracked);
    return check(root);
  };

  it("accepts paths, globs, placeholders, route folders, ignored build output and links", () => {
    const tracked = [
      "`apps/web/src/app/(app)/[id]/page.tsx` `apps/web/src/app/(app)/[id]/<file>.tsx`",
      "`packages/*` `packages/db/<name>.ts` `packages/db/**` `apps/{web,worker}`",
      "`apps/worker/dist/worker.mjs` `apps/worker/release`",
      "[other](other.md) [self](./TRACKED.md#top) [route](apps/web/src/app/(app)/[id]/page.tsx)",
    ].join("\n");
    assert.deepEqual(problems(tracked, "`apps/worker/src/index.ts`"), []);
  });

  it("reports missing paths in tracked and untracked documents with file and line", () => {
    assert.deepEqual(
      problems("ok\n`packages/db/missing.ts` `apps/*/nothing.ts`", "[gone](gone.md)"),
      [
        "TRACKED.md:2: packages/db/missing.ts does not exist",
        "TRACKED.md:2: apps/*/nothing.ts does not exist",
        "UNTRACKED.md:1: gone.md does not exist",
      ],
    );
  });

  it("fails a placeholder under a route folder that matches nothing", () => {
    assert.deepEqual(problems("`apps/web/src/app/(app)/[id]/<x>.css`"), [
      "TRACKED.md:1: apps/web/src/app/(app)/[id]/<x>.css does not exist",
    ]);
  });

  it("does not let ignored build output hide a typo in the workspace", () => {
    assert.deepEqual(problems("`apps/wroker/dist/worker.mjs`"), [
      "TRACKED.md:1: apps/wroker/dist/worker.mjs does not exist",
    ]);
  });

  it("treats link targets literally", () => {
    assert.deepEqual(problems("[missing](<nonexistent.md>) [glob](*.md)"), [
      "TRACKED.md:1: nonexistent.md does not exist",
      "TRACKED.md:1: *.md does not exist",
    ]);
  });

  it("rejects links that leave the repository", () => {
    assert.deepEqual(problems("[up](../outside.md)"), [
      "TRACKED.md:1: ../outside.md does not exist",
    ]);
  });
});
