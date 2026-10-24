import { artifacts } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { authed } from "@/lib/server/route";

export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/artifacts/[id]">) => {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    const [row] = await db
      .select({ bytes: artifacts.bytes, mime: artifacts.mime })
      .from(artifacts)
      .where(eq(artifacts.id, id));
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new Response(new Uint8Array(row.bytes), {
      headers: {
        "content-type": row.mime,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  },
);
