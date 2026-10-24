"use client";

import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { decideApproval } from "@/lib/actions";
import { approvalDetail, InlineCode } from "@/components/inline-code";
import { AlwaysAllowButton } from "./always-allow";
import { queryKeys, useAppState, useApprovals } from "@/lib/client/queries";
import type { ApprovalView } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABEL = {
  command: "Shell command",
  file_change: "File change",
  action: "Action",
  purchase: "Purchase",
  email: "Email",
} as const;

function ApprovalRow({ approval }: { approval: ApprovalView }) {
  const { data: state } = useAppState();
  const bot = state?.bots.find((b) => b.id === approval.botId);
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const decide = (decision: "approved" | "denied", alwaysAllow?: string) =>
    startTransition(async () => {
      const result = await decideApproval(
        approval.id,
        decision,
        alwaysAllow === undefined ? null : { pattern: alwaysAllow },
      );
      if (!result.ok) toast.error(result.error);
      else if (alwaysAllow !== undefined)
        toast("Approved, and allowed from now on", {
          description: `${bot?.name ?? "Your teammate"} won't ask about this again.`,
        });
      await queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
    });
  const open = approval.status === "pending";

  return (
    <li
      className={cn("flex gap-3.5 rounded-xl border bg-card p-4", open && "border-waiting/35")}
      data-testid="approval-row"
    >
      {bot ? (
        <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="md" />
      ) : (
        <span className="size-9 rounded-[10px] bg-subtle" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
          <span className="font-medium text-foreground">{bot?.name ?? "Former teammate"}</span>
          <span>{KIND_LABEL[approval.kind]}</span>
          <span>
            · {formatDistanceToNowStrict(new Date(approval.createdAt), { addSuffix: true })}
          </span>
          <Link href={`/chats/${approval.chatId}`} className="underline-offset-2 hover:underline">
            · Open chat
          </Link>
        </div>
        <span className="text-[15px] font-medium">
          <InlineCode text={approval.title} />
        </span>
        {approval.detail && (
          <pre className="max-h-48 overflow-auto rounded-lg bg-subtle px-3 py-2 font-sans text-[13px] whitespace-pre-wrap text-foreground/85">
            {approvalDetail(approval.detail)}
          </pre>
        )}
        {open ? (
          <div className="mt-1 flex gap-2">
            <Button size="sm" onClick={() => decide("approved")} disabled={pending}>
              <Check />
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide("denied")} disabled={pending}>
              Deny
            </Button>
            {approval.kind !== "purchase" && approval.kind !== "email" && (
              <AlwaysAllowButton
                kind={approval.kind}
                subject={approval.subject ?? approval.title}
                botName={bot?.name ?? "your teammate"}
                disabled={pending}
                onConfirm={async (pattern) => decide("approved", pattern)}
              />
            )}
          </div>
        ) : (
          <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {approval.status === "approved" ? (
              <Check className="size-3.5 text-done" />
            ) : (
              <X className="size-3.5" />
            )}
            {approval.status === "approved"
              ? "Approved"
              : approval.status === "denied"
                ? "Denied"
                : "Expired"}
            {approval.decidedAt &&
              ` ${formatDistanceToNowStrict(new Date(approval.decidedAt), { addSuffix: true })}`}
          </span>
        )}
      </div>
    </li>
  );
}

export function ApprovalsView() {
  const { data, isLoading } = useApprovals();
  const pending = (data ?? []).filter((approval) => approval.status === "pending");
  const decided = (data ?? []).filter((approval) => approval.status !== "pending");
  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  return (
    <div className="flex flex-col gap-8">
      {pending.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
          <ShieldCheck className="size-6 text-done" />
          <p className="font-medium">Nothing to approve</p>
          <p className="max-w-sm text-[13.5px] text-muted-foreground">
            Teammates ask here before sending, posting, buying or deleting anything. Set how careful
            each one is in their profile.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((approval) => (
            <ApprovalRow key={approval.id} approval={approval} />
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
            History
          </h2>
          <ul className="flex flex-col gap-2.5">
            {decided.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
