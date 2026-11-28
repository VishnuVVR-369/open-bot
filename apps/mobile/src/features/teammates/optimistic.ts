import type { TeammateSummary } from "@open-bot/api";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query";

/**
 * Makes one teammate the lead, moving the badge to them at once, then writes it. A read of the
 * team already on its way is called off first, so an answer from before the tap can't move the
 * badge back; a write that fails puts the badge back where it was, and only the badge, so news
 * of the team that came in meanwhile (a rename, a new teammate) stays. Resolves with the write's
 * error, or null.
 */
export async function setLeadOptimistically<E>(
  client: QueryClient,
  teammateId: string,
  write: () => Promise<{ error: E | null }>,
): Promise<E | null> {
  const key = queryKeys.teammates;
  await client.cancelQueries({ queryKey: key, exact: true });
  const leads = new Map(
    client.getQueryData<readonly TeammateSummary[]>(key)?.map((entry) => [entry.id, entry.isLead]),
  );
  client.setQueryData<readonly TeammateSummary[]>(key, (team) =>
    team?.map((teammate) => ({ ...teammate, isLead: teammate.id === teammateId })),
  );
  const { error } = await write();
  if (error)
    client.setQueryData<readonly TeammateSummary[]>(key, (team) =>
      team?.map((teammate) => ({
        ...teammate,
        // One that joined meanwhile was never the lead here; it isn't made one now.
        isLead: leads.get(teammate.id) ?? false,
      })),
    );
  return error;
}
