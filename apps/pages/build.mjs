import { build } from "esbuild";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Workspace packages export TypeScript source. Bundle them so `node dist/pages.mjs`
// does not depend on Node's limited strip-only TypeScript loader or extensionless TS imports.
await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/pages.mjs", import.meta.url)),
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

// The libraries pages load from /lib, next to the server.
await cp(
  fileURLToPath(new URL("../../packages/page-kit/dist/lib", import.meta.url)),
  fileURLToPath(new URL("./dist/lib", import.meta.url)),
  { recursive: true },
);
