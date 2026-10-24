import type { Metadata } from "next";
import { ApprovalsView } from "@/components/approvals/approvals-view";
import { Page } from "@/components/page";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <Page title="Approvals" description="Consequential actions wait here until you decide.">
      <ApprovalsView />
    </Page>
  );
}
