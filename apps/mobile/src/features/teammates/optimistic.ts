import type { TeammateSummary } from "@open-bot/api";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query";

/**
 * Makes one teammate the lead, moving the badge to them at once, then writes it. A read of the
 * team already on its way is called off first, so an answer from before the tap can't move the
 * badge back; a write that fails puts the team back as it was. Resolves with the write's error,
 * or null.
 */
export async function setLeadOptimistically<E>(
  client: QueryClient,
  teammateId: string,
  write: () => Promise<{ error: E | null }>,
): Promise<E | null> {
  const key = queryKeys.teammates;
  await client.cancelQueries({ queryKey: key, exact: true });
  const before = client.getQueryData<readonly TeammateSummary[]>(key);
  client.setQueryData<readonly TeammateSummary[]>(key, (team) =>
    team?.map((teammate) => ({ ...teammate, isLead: teammate.id === teammateId })),
  );
  const { error } = await write();
  if (error) client.setQueryData(key, before);
  return error;
}
