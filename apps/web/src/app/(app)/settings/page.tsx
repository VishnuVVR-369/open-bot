import type { Metadata } from "next";
import { Page } from "@/components/page";
import { SettingsView } from "@/components/settings/settings-view";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Page title="Settings" width="default">
      <SettingsView />
    </Page>
  );
}
