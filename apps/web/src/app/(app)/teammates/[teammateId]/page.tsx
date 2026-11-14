import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeammateView } from "@/features/teammates";
import { getTeammatePage, teammateName } from "@/features/teammates/server";

export async function generateMetadata({
  params,
}: PageProps<"/teammates/[teammateId]">): Promise<Metadata> {
  const { teammateId } = await params;
  return { title: (await teammateName(teammateId)) ?? "Teammate" };
}

export default async function TeammatePage({
  params,
  searchParams,
}: PageProps<"/teammates/[teammateId]">) {
  const { teammateId } = await params;
  const { tab } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(teammateId)) notFound();
  const teammate = await getTeammatePage(teammateId);
  if (!teammate) notFound();
  return <TeammateView teammate={teammate} tab={typeof tab === "string" ? tab : undefined} />;
}
