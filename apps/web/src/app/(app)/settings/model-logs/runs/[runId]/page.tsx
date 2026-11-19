import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunInspector } from "@/features/model-logs";
import { isUuid } from "@/lib/utils";

export const metadata: Metadata = { title: "Run inspector" };

export default async function RunInspectorPage({
  params,
}: PageProps<"/settings/model-logs/runs/[runId]">) {
  const { runId } = await params;
  if (!isUuid(runId)) notFound();
  return <RunInspector key={runId} runId={runId} />;
}
