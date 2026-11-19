import type { Metadata } from "next";
import { Page } from "@/components/page";
import { ModelLogsView } from "@/features/model-logs";

export const metadata: Metadata = { title: "Model logs" };

export default function ModelLogsPage() {
  return (
    <Page title="Settings" width="default">
      <ModelLogsView />
    </Page>
  );
}
