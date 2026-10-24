import { BOT_COLORS } from "@open-bot/shared";
import { bots } from "@open-bot/db";
import { isNull } from "drizzle-orm";
import type { Metadata } from "next";
import { BotForm } from "@/components/bots/bot-form";
import { Page } from "@/components/page";
import { db } from "@/lib/server/db";

export const metadata: Metadata = { title: "New teammate" };

export default async function NewBotPage() {
  const used = new Set(
    (await db.select({ color: bots.color }).from(bots).where(isNull(bots.archivedAt))).map(
      (row) => row.color,
    ),
  );
  const color = BOT_COLORS.find((candidate) => !used.has(candidate)) ?? BOT_COLORS[0];
  return (
    <Page
      title="New teammate"
      description="Give them a job. They work on the shared computer, remember what they learn, and ask you before anything risky."
    >
      <BotForm
        initial={{ name: "", role: "", instructions: "", color, emoji: "", autonomy: "risky" }}
        submitLabel="Create teammate"
      />
    </Page>
  );
}
