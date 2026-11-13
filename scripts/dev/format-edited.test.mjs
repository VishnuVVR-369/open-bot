import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(path.join(os.tmpdir(), "format-edited-"));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = path.join(root, "repo");
const cwd = path.join(repo, "subdir");
mkdirSync(cwd, { recursive: true });
execFileSync("git", ["init", "--quiet", repo]);
writeFileSync(path.join(repo, ".gitignore"), "ignored.js\n");
writeFileSync(path.join(repo, ".prettierignore"), "generated.js\n");
writeFileSync(path.join(repo, ".prettierrc.json"), '{"semi":false}\n');
const script = fileURLToPath(new URL("./format-edited.mjs", import.meta.url));
const source = "const value={x:1};\n";
const formatted = "const value = { x: 1 }\n";
const write = (name) => writeFileSync(path.join(cwd, name), source);
const read = (name) => readFileSync(path.join(cwd, name), "utf8");
const hook = (tool_input) =>
  execFileSync(process.execPath, [script], {
    cwd,
    input: JSON.stringify({ cwd, tool_input, hook_event_name: "PostToolUse" }),
    encoding: "utf8",
  });

test("Claude edit payload formats only the named file, using repo config from a subdirectory", () => {
  write("edited file.js");
  write("unrelated.js");
  assert.equal(hook({ file_path: path.join(cwd, "edited file.js") }), "");
  assert.equal(read("edited file.js"), formatted);
  assert.equal(read("unrelated.js"), source);
});

test("Codex patches format added, updated and moved destinations; deleted paths are skipped", () => {
  for (const file of ["added.js", "updated.js", "moved file.js"]) write(file);
  hook({
    command: [
      "*** Begin Patch",
      "*** Add File: added.js",
      "+const value={x:1};",
      "*** Update File: updated.js",
      "*** Update File: old.js",
      "*** Move to: moved file.js",
      "*** Delete File: deleted.js",
      "*** End Patch",
    ].join("\n"),
  });
  for (const file of ["added.js", "updated.js", "moved file.js"])
    assert.equal(read(file), formatted);
});

test("ignores generated files, unknown types, outside paths and symlinks out of the repo", () => {
  for (const file of ["ignored.js", "generated.js", "unknown.bin"]) write(file);
  const outside = path.join(root, "outside.js");
  writeFileSync(outside, source);
  symlinkSync(outside, path.join(cwd, "link.js"));
  for (const file of ["ignored.js", "generated.js", "unknown.bin", "link.js", outside]) {
    hook({ file_path: file });
    assert.equal(path.isAbsolute(file) ? readFileSync(file, "utf8") : read(file), source);
  }
});
