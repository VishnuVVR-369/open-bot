import type { Metadata } from "next";
import { ComputerPage } from "@/features/computer";

export const metadata: Metadata = { title: "Computer" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ screen?: string | string[] }>;
}) {
  const { screen } = await searchParams;
  return <ComputerPage initialScreen={typeof screen === "string" ? screen : null} />;
}
