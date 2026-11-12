import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv, unsetIfEmpty } from "./env";

const schema = z.object({
  TOKEN: z.string({ error: "set it" }).min(4, "set it to at least 4 characters"),
  PORT: unsetIfEmpty(z.coerce.number().int().positive()),
});

describe("parseEnv", () => {
  it("returns the parsed settings", () => {
    expect(parseEnv(schema, { TOKEN: "abcd", PORT: "80" })).toEqual({ TOKEN: "abcd", PORT: 80 });
  });

  it("treats an empty optional setting as unset", () => {
    expect(parseEnv(schema, { TOKEN: "abcd", PORT: "" })).toEqual({ TOKEN: "abcd" });
  });

  it("names every invalid variable, never its value", () => {
    expect(() => parseEnv(schema, { TOKEN: "s3c", PORT: "-1" })).toThrow(
      /^TOKEN: set it to at least 4 characters; PORT: .+$/,
    );
    try {
      parseEnv(schema, { TOKEN: "s3c", PORT: "-1" });
    } catch (error) {
      expect((error as Error).message).not.toContain("s3c");
    }
  });
});
