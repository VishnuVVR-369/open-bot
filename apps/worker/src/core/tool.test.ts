import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, text, type ToolDefinition } from "./tool";

// What a catalog of tools hands every tool, and a tool of that catalog. The checks here are
// mostly the compiler's: `pnpm typecheck` fails if a `@ts-expect-error` line stops being an error.
interface Catalog {
  tasks: { list(): string[] };
}
type CatalogTool = ToolDefinition<z.ZodObject, Catalog>;

const input = z.object({});
const tool = <Deps>(name: string, handle: ToolDefinition<typeof input, Deps>["handle"]) =>
  defineTool<typeof input, Deps>({ name, description: name, input, helpers: "allowed", handle });

describe("a tool's dependencies", () => {
  it("fit a catalog that gives what the tool asks for", () => {
    const fits: CatalogTool = tool<Pick<Catalog, "tasks">>("fits", async (_call, deps) =>
      text(deps.tasks.list().join(", ")),
    );
    expect(fits.name).toBe("fits");
  });

  it("don't fit a catalog that doesn't give one", () => {
    const missing = tool<Catalog & { missing: string }>("missing", async (_call, deps) =>
      text(deps.missing),
    );
    // @ts-expect-error The catalog gives no `missing`.
    const withMissing: CatalogTool[] = [missing];

    const archive = tool<{ tasks: { list(): string[]; archive(): void } }>(
      "archive",
      async (_call, deps) => {
        deps.tasks.archive();
        return text("archived");
      },
    );
    // @ts-expect-error The catalog's tasks service has no `archive`.
    const withArchive: CatalogTool[] = [archive];

    expect([...withMissing, ...withArchive]).toHaveLength(2);
  });
});
