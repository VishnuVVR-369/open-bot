import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeammateView } from "@/features/teammates";
import { getTeammatePage, teammateName } from "@/features/teammates/server";

export async function generateMetadata({ params }: PageProps<"/bots/[botId]">): Promise<Metadata> {
  const { botId } = await params;
  return { title: (await teammateName(botId)) ?? "Teammate" };
}

export default async function BotPage({ params, searchParams }: PageProps<"/bots/[botId]">) {
  const { botId } = await params;
  const { tab } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(botId)) notFound();
  const teammate = await getTeammatePage(botId);
  if (!teammate) notFound();
  return <TeammateView teammate={teammate} tab={typeof tab === "string" ? tab : undefined} />;
}
