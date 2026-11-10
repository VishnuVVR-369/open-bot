import type { Metadata } from "next";
import { BotForm } from "@/components/bots/bot-form";
import { Page } from "@/components/page";
import { nextTeammateColor } from "@/lib/server/queries";

export const metadata: Metadata = { title: "New teammate" };

export default async function NewBotPage() {
  const color = await nextTeammateColor();
  return (
    <Page
      title="New teammate"
      description="Give them a job. They remember what they learn and ask you before anything risky."
    >
      <BotForm
        initial={{ name: "", role: "", instructions: "", color, emoji: "", autonomy: "risky" }}
        submitLabel="Create teammate"
      />
    </Page>
  );
}
