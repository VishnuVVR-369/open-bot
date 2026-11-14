import type { Metadata } from "next";
import { TeammateForm } from "@/features/teammates";
import { Page } from "@/components/page";
import { nextColor } from "@/features/teammates/server";

export const metadata: Metadata = { title: "New teammate" };

export default async function NewTeammatePage() {
  const color = await nextColor();
  return (
    <Page
      title="New teammate"
      description="Give them a job. They remember what they learn and ask you before anything risky."
    >
      <TeammateForm
        initial={{ name: "", role: "", instructions: "", color, emoji: "", autonomy: "risky" }}
        submitLabel="Create teammate"
      />
    </Page>
  );
}
