import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Shows an automation's switch where you put it at once, then writes it. A read of the list already
 * on its way is called off first, so an answer from before the tap can't put the switch back; a
 * write that fails puts the list back as it was before the tap, so the switch never stays where it
 * didn't go. Resolves with the write's error, or null.
 */
export async function setEnabledOptimistically<E>(
  client: QueryClient,
  key: QueryKey,
  id: string,
  enabled: boolean,
  write: () => Promise<{ error: E | null }>,
): Promise<E | null> {
  await client.cancelQueries({ queryKey: key, exact: true });
  const before = client.getQueryData<readonly { id: string; enabled: boolean }[]>(key);
  client.setQueryData<readonly { id: string; enabled: boolean }[]>(key, (current) =>
    current?.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)),
  );
  const { error } = await write();
  if (error) client.setQueryData(key, before);
  return error;
}
