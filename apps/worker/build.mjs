import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Workspace packages export TypeScript source. Bundle them so `node dist/worker.mjs`
// does not depend on Node's limited strip-only TypeScript loader or extensionless TS imports.
await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/worker.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  plugins: [
    {
      name: "workspace-source",
      setup(build) {
        build.onResolve({ filter: /^@open-bot\// }, (args) => ({
          path: fileURLToPath(import.meta.resolve(args.path)),
        }));
      },
    },
  ],
});
