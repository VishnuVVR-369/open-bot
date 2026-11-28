import type { TeammateSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage, isRetryable } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryClient, queryKeys } from "@/lib/query";
import { setLeadOptimistically } from "./optimistic";
import { archiveText, leadText, madeCopy } from "./profile";

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
 * Asks, saying what stops and what stays, then archives the teammate. `onStart` and `onDone` let
 * the screen show it's on its way and leave once it's done.
 */
export function confirmArchive(
  teammate: Pick<TeammateSummary, "id" | "name" | "isLead">,
  { onStart, onDone }: { onStart: () => void; onDone: (archived: boolean) => void },
) {
  haptics.warning();
  Alert.alert(`Archive ${teammate.name}?`, archiveText(teammate), [
    { text: `Keep ${teammate.name}`, style: "cancel" },
    {
      text: "Archive",
      style: "destructive",
      onPress: async () => {
        onStart();
        const result = await safe(api.teammates.archive({ teammateId: teammate.id }));
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

/**
 * Makes a new teammate set up like this one. When the answer is lost, the team is read again: a
 * new teammate with that name is the copy, so trying again never makes a second one.
 */
export async function duplicateTeammate(
  teammateId: string,
  name: string,
  copyMemory: boolean,
): Promise<DuplicateOutcome> {
  const before = queryClient.getQueryData<TeammateSummary[]>(queryKeys.teammates) ?? [];
  const result = await safe(api.teammates.duplicate({ teammateId, name, copyMemory }));
  refreshTeam();
  void queryClient.invalidateQueries({ queryKey: queryKeys.allMemory });
  if (!result.error) {
    haptics.success();
    return { ok: true, teammateId: result.data.teammateId, memoryCopied: result.data.memoryCopied };
  }
  if (isRetryable(result.error) && before.length > 0) {
    const team = await safe(api.teammates.list());
    const copy = team.data ? madeCopy(before, team.data, name) : null;
    if (copy) {
      haptics.success();
      // Whether its memory came along isn't known; it's there if the copy managed it.
      return { ok: true, teammateId: copy, memoryCopied: true };
    }
  }
  haptics.error();
  return { ok: false, message: errorMessage(result.error, "Couldn't duplicate the teammate.") };
}
