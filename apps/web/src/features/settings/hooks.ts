"use client";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

export function useProfile() {
  return useQuery(orpc.profile.get.queryOptions());
}
