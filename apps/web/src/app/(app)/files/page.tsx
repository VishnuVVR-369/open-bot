import type { Metadata } from "next";
import { FilesView } from "@/components/files/files-view";
import { Page } from "@/components/page";

export const metadata: Metadata = { title: "Files" };

export default function FilesPage() {
  return (
    <Page title="Files" description="Everything your teammates keep on the shared computer.">
      <FilesView />
    </Page>
  );
}
