import { expect, test } from "vitest";
import { toolsFor } from "./definitions";

/** Sorted the same way however the tools are grouped in code: tools by name, keys, `required`. */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    if (key === "required") return [...(items as string[])].sort();
    if (key === "tools" || key === undefined)
      return [...items].sort((a, b) =>
        String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)),
      );
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, canonical((value as Record<string, unknown>)[name], name)]),
    );
  return value;
}

// Every tool as Codex sees it: names, descriptions and input schemas. A change here changes what
// teammates are offered, so review the snapshot diff like code.
test("the tool list Codex sees", async () => {
  await expect(`${JSON.stringify(canonical(toolsFor()), null, 2)}\n`).toMatchFileSnapshot(
    "./__snapshots__/tools.json",
  );
});
