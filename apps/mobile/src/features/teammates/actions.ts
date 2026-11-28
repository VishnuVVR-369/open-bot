import type { TeammateSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryClient, queryKeys } from "@/lib/query";
import { archivingTeammates } from "./archiving";
import { setLeadOptimistically } from "./optimistic";
import { archiveText, leadText } from "./profile";

/** Reads the team, and what lists it, again from the server. */
function refreshTeam() {
  for (const queryKey of [
    queryKeys.teammates,
    queryKeys.chats,
    queryKeys.home,
    queryKeys.schedules,
    queryKeys.triggers,
  ])
    void queryClient.invalidateQueries({ queryKey });
}

/**
 * Asks, then makes this teammate the lead, moving the badge at once; a refusal says why and puts
 * it back.
 */
export function confirmMakeLead(
  teammate: Pick<TeammateSummary, "id" | "name">,
  lead: Pick<TeammateSummary, "name"> | undefined,
) {
  haptics.tap();
  Alert.alert(`Make ${teammate.name} the lead?`, leadText(teammate, lead), [
    { text: "Cancel", style: "cancel" },
    {
      text: "Make lead",
      onPress: async () => {
        const error = await setLeadOptimistically(queryClient, teammate.id, () =>
          safe(api.teammates.setLead({ teammateId: teammate.id })),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
        if (error) {
          haptics.error();
          Alert.alert(`Couldn't make ${teammate.name} the lead`, errorMessage(error));
          return;
        }
        haptics.success();
      },
    },
  ]);
}

/**
 * Asks, saying what stops and what stays, then archives the teammate. While it's on its way,
 * `useArchiving` says so to every screen showing them; `onDone` lets the screen leave once it's
 * done.
 */
export function confirmArchive(
  teammate: Pick<TeammateSummary, "id" | "name" | "isLead">,
  { onDone }: { onDone: (archived: boolean) => void },
) {
  haptics.warning();
  Alert.alert(`Archive ${teammate.name}?`, archiveText(teammate), [
    { text: `Keep ${teammate.name}`, style: "cancel" },
    {
      text: "Archive",
      style: "destructive",
      onPress: async () => {
        archivingTeammates.set(teammate.id, true);
        const result = await safe(api.teammates.archive({ teammateId: teammate.id }));
        archivingTeammates.set(teammate.id, false);
        if (result.error) {
          haptics.error();
          Alert.alert(`Couldn't archive ${teammate.name}`, errorMessage(result.error));
          onDone(false);
          refreshTeam();
          return;
        }
        haptics.success();
        onDone(true);
        queryClient.setQueryData<TeammateSummary[]>(queryKeys.teammates, (team) =>
          team?.filter((entry) => entry.id !== teammate.id),
        );
        refreshTeam();
      },
    },
  ]);
}

export type DuplicateOutcome =
  { ok: true; teammateId: string; memoryCopied: boolean } | { ok: false; message: string };

/** What a duplicate asks for: the copy's name, whether memory comes along, and its id. */
export interface DuplicateAsk {
  teammateId: string;
  name: string;
  copyMemory: boolean;
  /**
   * The id the copy is made under, chosen before asking and kept by the screen: asked again with
   * it after a lost answer, the server answers with the copy the first ask made (and whether its
   * memory really came along) instead of making a second one.
   */
  copyId: string;
}

/** Makes a new teammate set up like this one. Safe to ask again with the same `copyId`. */
export async function duplicateTeammate(ask: DuplicateAsk): Promise<DuplicateOutcome> {
  const result = await safe(api.teammates.duplicate(ask));
  refreshTeam();
  void queryClient.invalidateQueries({ queryKey: queryKeys.allMemory });
  if (result.error) {
    haptics.error();
    return { ok: false, message: errorMessage(result.error, "Couldn't duplicate the teammate.") };
  }
  haptics.success();
  return { ok: true, teammateId: result.data.teammateId, memoryCopied: result.data.memoryCopied };
}
