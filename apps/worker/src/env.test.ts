import { describe, expect, it } from "vitest";
import { envSchema } from "./env";

describe("the worker's provider overrides", () => {
  const read = (overrides: Record<string, string>) => envSchema.safeParse(overrides);

  it.each(["GOOGLE_BASE_URL", "NOTION_MCP_URL"])("treats %s unset or empty as unset", (name) => {
    expect(read({}).data?.[name as "GOOGLE_BASE_URL"]).toBeUndefined();
    const empty = read({ [name]: "" });
    expect(empty.success).toBe(true);
    expect(empty.data?.[name as "GOOGLE_BASE_URL"]).toBeUndefined();
  });

  it.each(["GOOGLE_BASE_URL", "NOTION_MCP_URL"])(
    "takes a URL for %s, and refuses anything else",
    (name) => {
      expect(read({ [name]: "http://127.0.0.1:4796" }).data?.[name as "GOOGLE_BASE_URL"]).toBe(
        "http://127.0.0.1:4796",
      );
      expect(read({ [name]: "not a url" }).success).toBe(false);
    },
  );
});
