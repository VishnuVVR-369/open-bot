import type { Metadata } from "next";
import { AutomationsView, NewAutomationMenu } from "@/components/automations/automations-view";
import { Page } from "@/components/page";

export const metadata: Metadata = { title: "Automations" };

export default function AutomationsPage() {
  return (
    <Page
      title="Automations"
      description="Teammates get to work on their own: at the times you set, when a page changes, or when another service calls them. It all runs while your laptop is closed."
      actions={<NewAutomationMenu />}
    >
      <AutomationsView />
    </Page>
  );
}
