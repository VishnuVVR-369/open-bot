import { NextResponse } from "next/server";
import { pageThumbnail } from "@/features/pages/server";
import { authed } from "@/lib/server/route";
import { isUuid } from "@/lib/utils";

/** A version's picture for cards (`?theme=dark` for the dark one). A version never changes, so neither does its picture. */
export const GET = authed(
  async (request: Request, { params }: RouteContext<"/api/pages/versions/[id]/thumbnail">) => {
    const { id } = await params;
    const theme = new URL(request.url).searchParams.get("theme") === "dark" ? "dark" : "light";
    const thumbnail = isUuid(id) ? await pageThumbnail(id, theme) : null;
    if (!thumbnail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new Response(new Uint8Array(thumbnail), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  },
);
