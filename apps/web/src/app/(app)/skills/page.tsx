import type { Metadata } from "next";
import { Page } from "@/components/page";
import { SkillDialog, SkillsList } from "@/features/skills";

export const metadata: Metadata = { title: "Skills" };

export default function SkillsPage() {
  return (
    <Page
      title="Skills"
      description="Steps your teammates follow the same way every time. Type / in a chat to run one."
      actions={<SkillDialog />}
    >
      <SkillsList />
    </Page>
  );
}
