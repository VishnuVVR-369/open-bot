import type { ApprovalDecision, RuleKind } from "@open-bot/domain";
import { safe, isDefinedError } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useState } from "react";
import { api } from "./api";
import { errorMessage } from "./errors";
import { queryKeys } from "./query";

export type DecideResult =
  | { ok: true; status: ApprovalDecision }
  /** Decided somewhere else first, or it expired: `message` says how it ended. */
  | { ok: false; message: string; settled: boolean };

/**
 * Decide an approval. Purchases ask for your fingerprint before they're approved, as the
 * notification promised. A retry of the same decision is safe: the server answers it again.
 */
export function useDecideApproval() {
  const queryClient = useQueryClient();
  const [deciding, setDeciding] = useState<ApprovalDecision | null>(null);

  const decide = useCallback(
    async (
      approval: { id: string; kind: string; chatId?: string },
      decision: ApprovalDecision,
      /** Approve, and stop asking about what this pattern matches. */
      alwaysAllow: string | null = null,
    ): Promise<DecideResult> => {
      if (decision === "approved" && approval.kind === "purchase") {
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        if (level === LocalAuthentication.SecurityLevel.NONE)
          return {
            ok: false,
            message: "Set up a screen lock on this phone to approve purchases from it.",
            settled: false,
          };
        const check = await LocalAuthentication.authenticateAsync({
          promptMessage: "Approve this purchase",
          cancelLabel: "Cancel",
        });
        if (!check.success)
          return { ok: false, message: "Not approved: you cancelled the check.", settled: false };
      }
      setDeciding(decision);
      try {
        const result = await safe(
          api.approvals.decide({
            approvalId: approval.id,
            decision,
            alwaysAllow:
              decision === "approved" && alwaysAllow !== null ? { pattern: alwaysAllow } : null,
          }),
        );
        if (result.error) {
          const settled = isDefinedError(result.error) && result.error.code === "ALREADY_DECIDED";
          return { ok: false, message: errorMessage(result.error), settled };
        }
        return { ok: true, status: result.data.status as ApprovalDecision };
      } finally {
        setDeciding(null);
        void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
        void queryClient.invalidateQueries({ queryKey: queryKeys.home });
        if (alwaysAllow !== null)
          void queryClient.invalidateQueries({ queryKey: queryKeys.approvalRules });
        // A teammate shows "Needs your approval" until this is decided.
        void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
        void queryClient.invalidateQueries({ queryKey: queryKeys.approval(approval.id) });
        if (approval.chatId)
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat(approval.chatId) });
      }
    },
    [queryClient],
  );

  return { decide, deciding };
}

/**
 * Whether "Always allow" fits a request: not for purchases, emails, acting as you, or what always
 * asks. Changes to your accounts that only you see are allowed by tool.
 */
export function canAlwaysAllow(approval: {
  kind?: string;
  subject?: string | null;
  askEveryTime?: boolean;
}): approval is { kind: RuleKind; subject?: string | null; askEveryTime?: boolean } {
  if (approval.askEveryTime) return false;
  if (approval.kind === "file_change") return true;
  return (
    (approval.kind === "command" ||
      approval.kind === "action" ||
      approval.kind === "account_write") &&
    Boolean(approval.subject)
  );
}
