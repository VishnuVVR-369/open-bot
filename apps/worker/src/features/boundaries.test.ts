import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");
const FEATURES = path.join(SOURCE, "features");

/** Every TypeScript file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(file);
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/** The relative modules `source` imports or re-exports, resolved to paths without an extension. */
function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:import|export)\s[^"']*?from\s+["'](\.[^"']*)["']/g)].map(
    ([, specifier]) => path.resolve(path.dirname(file), specifier!),
  );
}

/** The feature folder `target` is in, if any, and whether it is that feature's index.ts. */
function featureOf(target: string) {
  const relative = path.relative(FEATURES, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  return { name: name!, index: rest.length === 0 || rest.join("/") === "index" };
}

describe("feature folders", () => {
  it("are reached from outside only through their index.ts", () => {
    const reachedIn: string[] = [];
    for (const file of files(SOURCE)) {
      const home = featureOf(file)?.name;
      for (const target of imports(file)) {
        const feature = featureOf(target);
        if (feature && feature.name !== home && !feature.index)
          reachedIn.push(`${path.relative(SOURCE, file)} -> ${path.relative(SOURCE, target)}`);
      }
    }
    expect(reachedIn).toEqual([]);
  });

  it("each have an index.ts", () => {
    for (const entry of readdirSync(FEATURES, { withFileTypes: true }))
      if (entry.isDirectory())
        expect(readdirSync(path.join(FEATURES, entry.name)), entry.name).toContain("index.ts");
  });
});
