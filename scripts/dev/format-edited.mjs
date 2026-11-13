// PostToolUse hook shared by Codex (apply_patch) and Claude Code (Edit/Write).
// Format only paths named by this edit, respecting repo ignores and symlinks.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as prettier from "prettier";

export function editedPaths(input) {
  const files = typeof input?.file_path === "string" ? [input.file_path] : [];
  if (typeof input?.command === "string") {
    for (const match of input.command.matchAll(
      /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm,
    )) {
      files.push(match[1]);
    }
  }
  return [...new Set(files)];
}

export async function formatEdited(root, cwd, input) {
  root = realpathSync(root);
  for (const file of editedPaths(input)) {
    const absolute = path.resolve(cwd, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const relative = path.relative(root, realpathSync(absolute));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      continue;
    const info = await prettier.getFileInfo(absolute, {
      ignorePath: [".gitignore", ".prettierignore"].map((name) => path.join(root, name)),
    });
    if (info.ignored || !info.inferredParser) continue;
    const before = readFileSync(absolute, "utf8");
    const after = await prettier.format(before, {
      ...(await prettier.resolveConfig(absolute)),
      filepath: absolute,
    });
    if (after !== before) writeFileSync(absolute, after);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8"));
    const cwd = event.cwd ?? process.cwd();
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
    await formatEdited(root, cwd, event.tool_input);
  } catch (error) {
    console.error(`Format edited files: ${error.message}`);
    process.exitCode = 1;
  }
}
