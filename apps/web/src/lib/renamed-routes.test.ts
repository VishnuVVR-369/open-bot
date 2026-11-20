import { stringify } from "node:querystring";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { memoryExportTeammateId, RENAMED_ROUTES } from "./renamed-routes";

const ID = "5b3c1f8e-1d2a-4b6c-9e7f-0a1b2c3d4e5f";
// The addresses before the rename, as bookmarks and old notifications still have them.
const OLD_PAGES = "/bots"; // vocabulary: allow (an old URL)
const OLD_API = "/api/bots"; // vocabulary: allow (an old URL)
const OLD_PARAM = "botId"; // vocabulary: allow (an old URL)

/**
 * Where a request for `url` is redirected, with its status, matched the way the Next.js router
 * does (`next/dist/server/lib/router-utils`), or null when no redirect applies.
 */
async function redirect(url: string): Promise<{ status: number; location: string } | null> {
  const parsed = new URL(url, "http://localhost");
  const query = Object.fromEntries(parsed.searchParams);
  for (const route of (await nextConfig.redirects?.()) ?? []) {
    const params = getPathMatch(route.source, { strict: true, removeUnnamedParams: true })(
      parsed.pathname,
    );
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: route.destination,
      params,
      query,
    });
    const search = stringify(parsedDestination.query);
    return {
      status: "permanent" in route && route.permanent ? 308 : 307,
      location: `${parsedDestination.pathname}${search ? `?${search}` : ""}`,
    };
  }
  return null;
}

describe("old addresses keep working", () => {
  it("serves every renamed route from next.config.ts", async () => {
    expect(await nextConfig.redirects?.()).toEqual(RENAMED_ROUTES);
  });

  it("opens a teammate's page, keeping the id and the query string", async () => {
    expect(await redirect(`${OLD_PAGES}/${ID}`)).toEqual({
      status: 308,
      location: `/teammates/${ID}`,
    });
    expect(await redirect(`${OLD_PAGES}/${ID}?tab=memory`)).toEqual({
      status: 308,
      location: `/teammates/${ID}?tab=memory`,
    });
    expect(await redirect(`${OLD_PAGES}/${ID}?tab=chats&x=1`)).toEqual({
      status: 308,
      location: `/teammates/${ID}?tab=chats&x=1`,
    });
  });

  it("opens the new-teammate form and keeps any sub-path", async () => {
    expect(await redirect(`${OLD_PAGES}/new`)).toEqual({ status: 308, location: "/teammates/new" });
    expect(await redirect(`${OLD_PAGES}/${ID}/a/b?c=d`)).toEqual({
      status: 308,
      location: `/teammates/${ID}/a/b?c=d`,
    });
  });

  it("downloads a teammate's export file", async () => {
    expect(await redirect(`${OLD_API}/${ID}/export`)).toEqual({
      status: 308,
      location: `/api/teammates/${ID}/export`,
    });
  });

  it("leaves current and unrelated addresses alone", async () => {
    expect(await redirect(`/teammates/${ID}?tab=memory`)).toBeNull();
    expect(await redirect("/teammates/new")).toBeNull();
    expect(await redirect(`/api/teammates/${ID}/export`)).toBeNull();
    expect(await redirect("/chats")).toBeNull();
    expect(await redirect("/robots.txt")).toBeNull();
    // Retired reads stay with `apps/web/src/lib/retired-routes.ts`, which tells old tabs to reload.
    expect(await redirect(`${OLD_API}/${ID}/lessons`)).toBeNull();
  });
});

describe("the memory download", () => {
  const teammate = (query: string) => memoryExportTeammateId(new URLSearchParams(query));

  it("reads the teammate from ?teammateId=, or from the parameter it had before", () => {
    expect(teammate(`teammateId=${ID}`)).toBe(ID);
    expect(teammate(`${OLD_PARAM}=${ID}`)).toBe(ID);
    expect(teammate(`teammateId=${ID}&${OLD_PARAM}=other`)).toBe(ID);
  });

  it("exports everyone's memory without either", () => {
    expect(teammate("")).toBeNull();
    expect(teammate("teammateId=")).toBeNull();
  });
});
