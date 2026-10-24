import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
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
