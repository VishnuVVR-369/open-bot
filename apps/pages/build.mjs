import { build } from "esbuild";
import { cp } from "node:fs/promises";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

// Bundle everything, workspace packages and libraries alike, so `node dist/pages.mjs` runs on
// its own. Imports a workspace package makes (zod, cron-parser) aren't dependencies of this app,
// so pnpm doesn't link them where an external import from dist/ would look.
const result = await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/pages.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // pg's optional native binding, which it loads only when asked to.
  external: ["pg-native"],
  // CommonJS libraries (pg) call require() for Node's built-ins, which ESM doesn't define.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  metafile: true,
});

// Fail the build, not the deploy: only Node's own modules may be left for runtime.
const builtins = new Set(builtinModules);
const external = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external)
  .map((entry) => entry.path)
  .filter((path) => !path.startsWith("node:") && !builtins.has(path) && path !== "pg-native");
if (external.length > 0) {
  throw new Error(
    `dist/pages.mjs would import packages at runtime: ${[...new Set(external)].join(", ")}`,
  );
}

// The libraries pages load from /lib, next to the server.
await cp(
  fileURLToPath(new URL("../../packages/page-kit/dist/lib", import.meta.url)),
  fileURLToPath(new URL("./dist/lib", import.meta.url)),
  { recursive: true },
);
