import type { Metadata } from "next";
import { Page } from "@/components/page";
import { PagesView } from "@/components/pages/pages-view";

export const metadata: Metadata = { title: "Pages" };

export default function PagesPage() {
  return (
    <Page
      title="Pages"
      description="Explainers, comparisons and dashboards your teammates made for you. Ask for one in any chat."
      width="wide"
    >
      <PagesView />
    </Page>
  );
}
