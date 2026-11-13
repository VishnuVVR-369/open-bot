"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** What a folder on the computer holds. Skipped while `enabled` is false, as when it is offline. */
export function useFolder(path: string, enabled: boolean) {
  return useQuery(orpc.files.list.queryOptions({ input: { path }, enabled }));
}
