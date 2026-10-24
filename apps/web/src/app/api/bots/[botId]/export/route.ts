import { bots } from "@open-bot/db";
import { bundleFileName } from "@open-bot/shared";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { authed } from "@/lib/server/route";
import { teammateParts, toBundle } from "@/lib/server/teammates";

/** The teammate as a file you can keep or import elsewhere. */
export const GET = authed(
  async (_request: Request, { params }: RouteContext<"/api/bots/[botId]/export">) => {
    const { botId } = await params;
    const [bot] = /^[0-9a-f-]{36}$/i.test(botId)
      ? await db
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), isNull(bots.archivedAt)))
      : [];
    if (!bot) return NextResponse.json({ error: "No such teammate." }, { status: 404 });
    const bundle = toBundle(
      {
        name: bot.name,
        role: bot.role,
        instructions: bot.instructions,
        emoji: bot.emoji,
        color: bot.color,
        autonomy: bot.autonomy,
      },
      await teammateParts(bot.id),
    );
    return new Response(`${JSON.stringify(bundle, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${bundleFileName(bot.slug)}"`,
      },
    });
  },
);
