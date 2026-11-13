import "server-only";
import { ownerSettings } from "@open-bot/db";
import { db } from "@/lib/server/db";
import type { ProfileView } from "@/lib/types";

export async function getProfile(): Promise<ProfileView> {
  const row = await ownerSettings(db);
  return {
    aboutMe: row?.aboutMe ?? "",
    updatedAt: row?.aboutMeUpdatedAt?.toISOString() ?? null,
  };
}
