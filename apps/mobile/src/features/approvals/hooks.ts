import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export const useApprovals = () =>
  useQuery({ queryKey: queryKeys.approvals, queryFn: () => api.approvals.list() });

export const useApprovalRules = () =>
  useQuery({ queryKey: queryKeys.approvalRules, queryFn: () => api.approvals.rules() });
