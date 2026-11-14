import "server-only";
import { listSkills } from "@/features/skills/server";
import { listTeammates } from "@/features/teammates/server";
import { listChats } from "@/features/chat/server";
import { listActiveTakeovers } from "@/features/computer/server";
import { ownerTimeZone } from "@open-bot/db";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import type { AppState } from "@/lib/types";
import { db } from "@/lib/server/db";
import { workerStatus } from "@/lib/server/worker-status";
import { getAttention } from "./attention";

export async function getAppState(user: { name: string; email: string }): Promise<AppState> {
  const [team, chatList, status, attention, activeTakeovers, timezone, skillList] =
    await Promise.all([
      listTeammates(),
      listChats({ previews: false }),
      workerStatus(),
      getAttention(),
      listActiveTakeovers(),
      ownerTimeZone(db),
      listSkills(),
    ]);
  return {
    ...attention,
    user,
    timezone,
    teammates: team,
    chats: chatList,
    skills: skillList.map(({ instructions: _, ...summary }) => summary),
    computer: {
      workerOnline: status !== null,
      lifecycle: status?.computer.lifecycle ?? null,
      online: status?.computer.online ?? false,
      health: status?.computer.health ?? null,
      egress: status?.egress ?? OFFLINE_EGRESS_STATUS,
    },
    codex: status?.codex ?? null,
    activeTakeovers: activeTakeovers.flatMap((row) =>
      row.screenId
        ? [{ id: row.id, screenId: row.screenId, startedAt: row.startedAt?.toISOString() ?? null }]
        : [],
    ),
  };
}
