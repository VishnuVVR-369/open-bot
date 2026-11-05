import { NextResponse } from "next/server";
import { ApiError } from "@/lib/server/api/errors";
import { openPage } from "@/lib/server/api/pages";
import { authed } from "@/lib/server/route";
import { isUuid } from "@/lib/utils";

/** A short-lived address that shows this version, on the pages origin. */
export const GET = authed(
  async (request: Request, { params }: RouteContext<"/api/pages/versions/[id]/link">) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "That page was deleted." }, { status: 404 });
    const search = new URL(request.url).searchParams;
    const theme = search.get("theme");
    try {
      const link = await openPage({
        versionId: id,
        theme: theme === "dark" || theme === "light" ? theme : undefined,
        ask: search.get("ask") === "1",
      });
      return NextResponse.json(link, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ApiError && error.code === "NOT_FOUND")
        return NextResponse.json({ error: error.message }, { status: 404 });
      throw error;
    }
  },
);
