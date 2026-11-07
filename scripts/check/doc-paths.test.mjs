// Unit tests for the doc path check (scripts/check/doc-paths.mjs). Needs only Node and git:
// `pnpm test:scripts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { check, codeSpanPath, linkPath, referencedPaths, toGlob } from "./doc-paths.mjs";

describe("referencedPaths", () => {
  it("finds code spans rooted at apps/ or packages/, with line numbers", () => {
    const text = "See `apps/web/src/app` and `packages/db`.\nNot `src/index.ts` or `pnpm test`.";
    assert.deepEqual(referencedPaths(text), [
      { line: 1, path: "apps/web/src/app", kind: "code" },
      { line: 1, path: "packages/db", kind: "code" },
    ]);
  });

  it("skips fenced code blocks, including longer fences", () => {
    const text = [
      "```sh",
      "cat `apps/missing.ts`",
      "```",
      "````md",
      "```",
      "`apps/inner`",
      "````",
      "`apps/after`",
    ].join("\n");
    assert.deepEqual(
      referencedPaths(text).map((found) => found.path),
      ["apps/after"],
    );
  });

  it("finds relative Markdown links, not URLs, site routes or anchors", () => {
    const text =
      "[a](../x.md) [b](https://x.dev) [c](/docs/flows) [d](#top) [e](mailto:a@b.c) [f](y.md#part)";
    assert.deepEqual(
      referencedPaths(text).map((found) => found.path),
      ["../x.md", "y.md"],
    );
  });
});

describe("codeSpanPath", () => {
  it("strips line references and a trailing slash", () => {
    assert.equal(codeSpanPath("apps/worker/src/http.ts:871"), "apps/worker/src/http.ts");
    assert.equal(codeSpanPath("apps/worker/src/http.ts:222-837"), "apps/worker/src/http.ts");
    assert.equal(codeSpanPath("packages/shared/"), "packages/shared");
  });

  it("ignores commands and other roots", () => {
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
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "doc-paths-"));
    const git = (...args) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    mkdirSync(path.join(root, "apps/web/src/app/[id]"), { recursive: true });
    writeFileSync(path.join(root, "apps/web/src/app/[id]/page.tsx"), "");
    mkdirSync(path.join(root, "packages/db"), { recursive: true });
    writeFileSync(path.join(root, "packages/db/schema.ts"), "");
    writeFileSync(path.join(root, ".gitignore"), "dist/\n");
    writeFileSync(path.join(root, "other.md"), "");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const problems = (markdown) => {
    writeFileSync(path.join(root, "README.md"), markdown);
    return check(root);
  };

  it("accepts paths, globs, placeholders, route folders, ignored build output and links", () => {
    assert.deepEqual(
      problems(
        [
          "`apps/web/src/app/[id]/page.tsx` `packages/*` `packages/db/<name>.ts` `packages/db/**`",
          "`apps/worker/dist/worker.mjs` [other](other.md) [self](./README.md#top)",
        ].join("\n"),
      ),
      [],
    );
  });

  it("reports each missing path with its file and line", () => {
    assert.deepEqual(
      problems("ok\n`packages/db/missing.ts` `apps/*/nothing.ts`\n[gone](gone.md)"),
      [
        "README.md:2: packages/db/missing.ts does not exist",
        "README.md:2: apps/*/nothing.ts does not exist",
        "README.md:3: gone.md does not exist",
      ],
    );
  });

  it("rejects links that leave the repository", () => {
    assert.deepEqual(problems("[up](../outside.md)"), [
      "README.md:1: ../outside.md does not exist",
    ]);
  });
});
