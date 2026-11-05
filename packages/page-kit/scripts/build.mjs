// Assembles dist/lib: what pages load from /lib on their own origin. The pages service serves it,
// and the computer's preview server serves the same files, so a page looks the same in both.
import { cp, mkdir, rm, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist/lib");
// Each library's folder, as pnpm links it (some packages don't export package.json to resolve).
const pkg = (name) => join(root, "node_modules", name);

/** [source, destination under lib/] */
const files = [
  [join(root, "src/runtime.js"), "runtime.js"],
  [join(root, "src/kit/page.css"), "kit@1/page.css"],
  [join(root, "src/kit/kit.js"), "kit@1/kit.js"],
  [join(pkg("mermaid"), "dist/mermaid.min.js"), "mermaid@12/mermaid.min.js"],
  [join(pkg("chart.js"), "dist/chart.umd.min.js"), "chart.js@4/chart.umd.min.js"],
  [join(pkg("d3"), "dist/d3.min.js"), "d3@7/d3.min.js"],
  [join(pkg("katex"), "dist/katex.min.js"), "katex@0.19/katex.min.js"],
  [join(pkg("katex"), "dist/katex.min.css"), "katex@0.19/katex.min.css"],
  [join(pkg("katex"), "dist/contrib/auto-render.min.js"), "katex@0.19/auto-render.min.js"],
  [join(pkg("katex"), "dist/fonts"), "katex@0.19/fonts"],
  [join(pkg("@highlightjs/cdn-assets"), "highlight.min.js"), "highlight@11/highlight.min.js"],
];

const fonts = {
  "@fontsource-variable/onest": [
    "onest-latin-wght-normal.woff2",
    "onest-latin-ext-wght-normal.woff2",
  ],
  "@fontsource-variable/familjen-grotesk": [
    "familjen-grotesk-latin-wght-normal.woff2",
    "familjen-grotesk-latin-ext-wght-normal.woff2",
  ],
  "@fontsource-variable/jetbrains-mono": [
    "jetbrains-mono-latin-wght-normal.woff2",
    "jetbrains-mono-latin-ext-wght-normal.woff2",
  ],
};
for (const [name, list] of Object.entries(fonts))
  for (const file of list) files.push([join(pkg(name), "files", file), `fonts/${file}`]);

await rm(out, { recursive: true, force: true });
for (const [source, destination] of files) {
  const target = join(out, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

// A list of every file with its hash, so a test (or a curious person) can see what is served.
async function walk(dir) {
  const entries = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) entries.push(...(await walk(path)));
    else entries.push(path);
  }
  return entries;
}
const manifest = {};
for (const path of (await walk(out)).sort()) {
  const data = await readFile(path);
  manifest[relative(out, path)] = createHash("sha256").update(data).digest("hex").slice(0, 16);
}
await writeFile(join(root, "dist/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`page-kit: ${Object.keys(manifest).length} files in dist/lib`);
