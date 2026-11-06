import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

// `node dist/worker.mjs` can only import, at runtime, what pnpm links next to this app: Node's
// built-ins and the worker's own dependencies. Those stay external. Everything else is bundled:
// workspace packages (which export TypeScript source) and the libraries they import that the worker
// doesn't declare itself, such as @open-bot/api's @orpc/contract.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules);
const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const isRuntimeImport = (specifier) =>
  specifier.startsWith("node:") ||
  builtins.has(specifier) ||
  (declared.has(packageName(specifier)) && !specifier.startsWith("@open-bot/"));

const result = await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/worker.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // A bundled CommonJS library calls require() for Node's built-ins, which ESM doesn't define.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  metafile: true,
  plugins: [
    {
      name: "runtime-imports",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@open-bot/")) {
            return { path: fileURLToPath(import.meta.resolve(args.path)) };
          }
          if (isRuntimeImport(args.path)) return { path: args.path, external: true };
          // Anything else resolves as usual from the importing file and is bundled.
          return undefined;
        });
      },
    },
  ],
});

// Fail the build, not the deploy, if anything else is left for runtime.
const unresolvable = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !isRuntimeImport(entry.path))
  .map((entry) => entry.path);
if (unresolvable.length > 0) {
  throw new Error(
    `dist/worker.mjs would import packages the worker doesn't depend on: ${[...new Set(unresolvable)].join(", ")}`,
  );
}
