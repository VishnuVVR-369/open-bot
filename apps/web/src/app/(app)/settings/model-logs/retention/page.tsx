import type { Metadata } from "next";
import { Page } from "@/components/page";
import { ModelLogsView } from "@/features/model-logs";

export const metadata: Metadata = { title: "Model log retention" };

export default function ModelLogsRetentionPage() {
  return (
    <Page title="Settings" width="default">
      <ModelLogsView tab="retention" />
    </Page>
  );
}
