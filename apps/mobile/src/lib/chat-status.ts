import {
  chatStatus,
  STATUS,
  type ActiveRunFacts,
  type ChatNaming,
  type ChatStatus,
  type TeammateActivity,
} from "@open-bot/domain";

/**
 * A chat's own status, for its header: what is happening in this chat, never what its teammates
 * are doing somewhere else. A direct chat's comes straight from the shared `chatStatus` (the web
 * says the same); a group's is the most pressing of its members' statuses in it.
 */

/** Waiting on you first, then work moving, then waiting its turn, then paused, then nothing. */
const RANK: Record<TeammateActivity, number> = {
  waiting: 0,
  working: 1,
  queued: 2,
  paused: 3,
  idle: 4,
};

export function headerStatus({
  members,
  group,
  chatId,
  computerOnline,
  chatById,
}: {
  members: { activeRun: ActiveRunFacts | null }[];
  group: boolean;
  chatId: string;
  computerOnline: boolean;
  chatById: (id: string) => ChatNaming | null | undefined;
}): ChatStatus {
  const each = members.map((bot) => chatStatus({ bot, chatId, computerOnline, chatById }));
  if (!group)
    return each[0] ?? chatStatus({ bot: { activeRun: null }, chatId, computerOnline, chatById });
  const top = [...each].sort((a, b) => RANK[a.activity] - RANK[b.activity])[0];
  // A group's header has no room to point at each member's other chats.
  return top
    ? { ...top, elsewhere: null }
    : { label: STATUS.idle, activity: "idle", needsYou: false, elsewhere: null };
}
