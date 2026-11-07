import type { Metadata } from "next";
import { AutomationsView, NewAutomationMenu } from "@/components/automations/automations-view";
import { Page } from "@/components/page";

export const metadata: Metadata = { title: "Automations" };

export default function AutomationsPage() {
  return (
    <Page
      title="Automations"
      description="Work your teammates start on their own, on a schedule or when something happens."
      actions={<NewAutomationMenu />}
    >
      <AutomationsView />
    </Page>
  );
}
