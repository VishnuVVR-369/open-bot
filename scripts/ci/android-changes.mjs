import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

export function androidInputs(root) {
  // These are the workspace locations in pnpm-workspace.yaml. A change to that
  // root file always runs Android, including additions outside these locations.
  const manifests = git(
    root,
    "ls-files",
    "-z",
    "--",
    ...["apps", "packages", "tools"].map((directory) => `:(glob)${directory}/*/package.json`),
  )
    .split("\0")
    .filter(Boolean);
  const workspaces = new Map(
    manifests.map((file) => {
      const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
      return [manifest.name, { directory: path.posix.dirname(file), manifest }];
    }),
  );
  const inputs = new Set();
  function visit(name) {
    const workspace = workspaces.get(name);
    if (!workspace) throw new Error(`Missing workspace ${name}`);
    if (inputs.has(workspace.directory)) return;
    inputs.add(workspace.directory);
    for (const [dependency, version] of Object.entries({
      ...workspace.manifest.dependencies,
      ...workspace.manifest.devDependencies,
      ...workspace.manifest.optionalDependencies,
      ...workspace.manifest.peerDependencies,
    })) {
      if (workspaces.has(dependency) || version.startsWith("workspace:")) visit(dependency);
    }
  }
  visit("@open-bot/mobile");
  inputs.add("packages/egress"); // Kotlin reads its protocol vectors.
  return inputs;
}

export function needsAndroid(root, base, head) {
  // Missing history or malformed manifests must never suppress a native check.
  try {
    if (!base || !head) throw new Error("Missing comparison refs");
    const inputs = androidInputs(root);
    // A PR-wide diff, not just the latest commit. Disable rename detection so
    // moving a native source out of mobile still counts as a mobile deletion.
    const changed = git(
      root,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${base}...${head}`,
      "--",
    )
      .split("\0")
      .filter(Boolean);
    return changed.some((file) => {
      if ([...inputs].some((directory) => file.startsWith(`${directory}/`))) return true;
      // Other workspaces, end-to-end tests, images and agent instructions don't
      // feed the Android build. Unknown locations and root config run it.
      if (/^(apps|packages|tools)\/[^/]+\//.test(file)) return false;
      if (/^(e2e|images|\.agents)\//.test(file)) return false;
      if (!file.includes("/") && /\.md$/i.test(file)) return false;
      return true;
    });
  } catch (error) {
    console.warn(`Running Android checks: ${error.message}`);
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Always build main to exercise the complete matrix and warm trusted caches.
  const android =
    process.env.GITHUB_EVENT_NAME !== "pull_request" ||
    needsAndroid(process.cwd(), process.env.BASE_SHA, process.env.HEAD_SHA);
  console.log(`Android checks required: ${android}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `android=${android}\n`);
}
