import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildVectors } from "./vectors";

const DIR = path.join(import.meta.dirname, "..", "test-vectors");
const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("test vectors", () => {
  it("match what this package does (run `pnpm --filter @open-bot/egress vectors` after a change)", async () => {
    const vectors = await buildVectors();
    if (process.env.UPDATE_VECTORS === "1") {
      mkdirSync(DIR, { recursive: true });
      for (const [name, value] of Object.entries(vectors))
        writeFileSync(path.join(DIR, name), serialize(value));
    }
    for (const [name, value] of Object.entries(vectors))
      expect(readFileSync(path.join(DIR, name), "utf8"), name).toBe(serialize(value));
  });
});
