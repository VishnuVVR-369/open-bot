import { NextResponse } from "next/server";
import { pageDownload } from "@/features/pages/server";
import { authed } from "@/lib/server/route";
import { isUuid } from "@/lib/utils";

/** A version as an .html file to keep or send. */
export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/pages/versions/[id]/download">) => {
    const { id } = await params;
    const file = isUuid(id) ? await pageDownload(id) : null;
    if (!file) return NextResponse.json({ error: "That page was deleted." }, { status: 404 });
    const base =
      file.title
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80) || "page";
    const name = `${base}-v${file.number}.html`;
    return new Response(file.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // An attachment, never shown here: the app's origin must not run a page's scripts.
        "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  },
);
