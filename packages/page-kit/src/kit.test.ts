import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGE_KIT, PAGE_LIBRARIES } from "./index";
import { readLibFile } from "./serve";
import { PAGE_SKILL_MARKDOWN, PAGE_TEMPLATE_HTML } from "./skill";

// Built by the test script before the tests run.
const libDir = fileURLToPath(new URL("../dist/lib", import.meta.url));

/** Every /lib/… address in a text. */
function libPaths(text: string): string[] {
  return [
    ...new Set([...text.matchAll(/\/lib\/[\w@.\-/]+\.(?:js|css)/g)].map((match) => match[0])),
  ];
}

describe("the page kit", () => {
  it("has every file the skill, the template and the library list point to", async () => {
    const paths = new Set([
      PAGE_KIT.css,
      PAGE_KIT.js,
      "/lib/runtime.js",
      ...PAGE_LIBRARIES.flatMap((library) => library.tags.flatMap(libPaths)),
      ...libPaths(PAGE_SKILL_MARKDOWN),
      ...libPaths(PAGE_TEMPLATE_HTML),
    ]);
    expect(paths.size).toBeGreaterThan(8);
    for (const path of paths) expect(await readLibFile(libDir, path), path).not.toBeNull();
  });

  it("has the fonts its stylesheets use", async () => {
    for (const css of [PAGE_KIT.css, "/lib/katex@0.19/katex.min.css"]) {
      const file = await readLibFile(libDir, css);
      const base = css.slice(0, css.lastIndexOf("/") + 1);
      const fonts = [...file!.data.toString().matchAll(/url\(["']?([^)"']+\.woff2)["']?\)/g)].map(
        (match) => new URL(match[1]!, `https://pages.example${base}`).pathname,
      );
      expect(fonts.length, css).toBeGreaterThan(0);
      for (const font of fonts) expect(await readLibFile(libDir, font), font).not.toBeNull();
    }
  });

  it("serves files with types and caching any page can use", async () => {
    const file = await readLibFile(libDir, PAGE_KIT.css);
    expect(file!.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(file!.headers["access-control-allow-origin"]).toBe("*");
    expect(file!.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(file!.headers["x-content-type-options"]).toBe("nosniff");
    expect(file!.headers.etag).toMatch(/^"[\w-]{22}"$/);
  });

  it("serves nothing outside the library folder", async () => {
    for (const path of [
      "/lib/../package.json",
      "/lib/%2e%2e/%2e%2e/package.json",
      "/lib/kit@1/../../../src/index.ts",
      "/lib/",
      "/lib/kit@1",
      "/lib/kit@1/page.css%00.js",
      "/lib/%E0%A4%A",
      "/other/kit@1/page.css",
      "/lib/manifest.json/x.js",
    ])
      expect(await readLibFile(libDir, path), path).toBeNull();
  });

  it("starts the template with what check_page requires", () => {
    expect(PAGE_TEMPLATE_HTML).toMatch(/^<!doctype html>/i);
    expect(PAGE_TEMPLATE_HTML).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(PAGE_TEMPLATE_HTML).toMatch(/<title>[^<]+<\/title>/);
    // It loads nothing from outside the page and /lib (links to sources are fine).
    expect(PAGE_TEMPLATE_HTML).not.toMatch(/src="(?:https?:)?\/\//);
    expect(PAGE_TEMPLATE_HTML).not.toMatch(/<link[^>]+href="(?:https?:)?\/\//);
  });
});
