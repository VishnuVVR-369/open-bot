import type { Metadata } from "next";
import { Page } from "@/components/page";
import { SkillDialog } from "@/components/skills/skill-dialog";
import { SkillsList } from "@/components/skills/skills-list";

export const metadata: Metadata = { title: "Skills" };

export default function SkillsPage() {
  return (
    <Page
      title="Skills"
      description="Step-by-step instructions your teammates follow the same way every time. Type / in any chat to run one."
      actions={<SkillDialog />}
    >
      <SkillsList />
    </Page>
  );
}
