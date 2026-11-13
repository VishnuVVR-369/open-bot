"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Every skill, with its instructions. The shell's state lists them without. */
export function useSkills() {
  return useQuery(orpc.skills.list.queryOptions());
}
