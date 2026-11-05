import { NextResponse } from "next/server";
import { ApiError } from "@/lib/server/api/errors";
import { getPage } from "@/lib/server/api/pages";
import { authed } from "@/lib/server/route";
import { isUuid } from "@/lib/utils";

export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/pages/[id]">) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "That page was deleted." }, { status: 404 });
    try {
      return NextResponse.json(await getPage(id));
    } catch (error) {
      if (error instanceof ApiError && error.code === "NOT_FOUND")
        return NextResponse.json({ error: error.message }, { status: 404 });
      throw error;
    }
  },
);
