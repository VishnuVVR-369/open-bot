import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export const useTeammates = () =>
  useQuery({ queryKey: queryKeys.teammates, queryFn: () => api.teammates.list() });

/** The instructions a teammate suggests for itself and you haven't decided, or null. */
export const usePendingProposal = (teammateId: string) =>
  useQuery({
    queryKey: queryKeys.proposal(teammateId),
    queryFn: () => api.proposals.pending({ teammateId }),
  });

/** A teammate's profile to edit, with the revision a save sends back. */
export const useTeammateProfile = (teammateId: string) =>
  useQuery({
    queryKey: queryKeys.teammateProfile(teammateId),
    queryFn: () => api.teammates.profile({ teammateId }),
  });
