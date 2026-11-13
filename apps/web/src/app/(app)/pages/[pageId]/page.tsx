import type { Metadata } from "next";
import { PageViewer } from "@/features/pages";

export const metadata: Metadata = { title: "Page" };

export default async function PageViewerPage({
  params,
  searchParams,
}: PageProps<"/pages/[pageId]">) {
  const { pageId } = await params;
  const { v } = await searchParams;
  return <PageViewer key={pageId} pageId={pageId} versionId={typeof v === "string" ? v : null} />;
}
