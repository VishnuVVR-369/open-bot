import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  // The Node that Electron embeds, not the repo's: every Electron in package.json's range (^44.7.0)
  // ships Node 24.21 or later. See "Invariants" in AGENTS.md for checking it on an upgrade.
  target: "node24.21",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs", format: "cjs" });
await build({
  ...common,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  format: "cjs",
});
