import type { Metadata } from "next";
import { Page } from "@/components/page";
import { ModelLogsView } from "@/features/model-logs";

export const metadata: Metadata = { title: "Model log usage" };

export default function ModelLogsUsagePage() {
  return (
    <Page title="Settings" width="default">
      <ModelLogsView tab="usage" />
    </Page>
  );
}
