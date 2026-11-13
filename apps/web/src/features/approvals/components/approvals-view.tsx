"use client";

import { ArrowRight, Check, CircleDashed, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { BotAvatar } from "@/components/bot-avatar";
import { TimeAgo } from "@/components/time-ago";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppState } from "@/lib/client/queries";
import { useApprovals } from "../hooks";
import type { ApprovalView, BotSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ApprovalReview,
  ApprovalTitle,
  NEEDS_YOU_SURFACE,
  RiskChip,
  riskOf,
} from "./approval-parts";

const KIND_LABEL = {
  command: "Shell command",
  file_change: "File change",
  action: "Action",
  purchase: "Purchase",
  email: "Email",
  account_write: "Your account",
  account_outward: "Acts as you",
} as const;

function OpenChat({ chatId, className }: { chatId: string; className?: string }) {
  return (
    <Link
      href={`/chats/${chatId}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md text-[13px] font-medium text-foreground/80 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12",
        className,
      )}
    >
      Open chat
      <ArrowRight className="size-3.5" />
    </Link>
  );
}

function Avatar({ bot, size }: { bot: BotSummary | undefined; size: "sm" | "md" }) {
  return bot ? (
    <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size={size} />
  ) : (
    <span
      className={cn(
        "shrink-0 bg-subtle",
        size === "md" ? "size-9 rounded-[10px]" : "size-7 rounded-[8px]",
      )}
    />
  );
}

/** An approval waiting on you: what it does, what's at stake, and the decision. */
function PendingApproval({ approval, bot }: { approval: ApprovalView; bot?: BotSummary }) {
  const risk = riskOf(approval);
  return (
    <li
      className={cn("flex gap-3.5 rounded-xl p-4 sm:p-5", NEEDS_YOU_SURFACE)}
      data-testid="approval-row"
    >
      <Avatar bot={bot} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">{bot?.name ?? "Former teammate"}</span>
            {!risk && <span>{KIND_LABEL[approval.kind]}</span>}
            <TimeAgo date={approval.createdAt} />
            <span aria-hidden>·</span>
            <OpenChat chatId={approval.chatId} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="text-[15.5px] leading-snug font-medium">
              <ApprovalTitle approval={approval} />
            </h3>
            {risk && <RiskChip risk={risk} />}
          </div>
        </div>
        <ApprovalReview
          approvalId={approval.id}
          approval={approval}
          botName={bot?.name ?? "your teammate"}
        />
      </div>
    </li>
  );
}

/** A decided approval, one line: who, what, how you decided, and when. */
function DecidedApproval({ approval, bot }: { approval: ApprovalView; bot?: BotSummary }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-testid="approval-row">
      <Avatar bot={bot} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px]">
          <ApprovalTitle approval={approval} showCommand />
        </span>
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          {approval.status === "approved" ? (
            <Check className="size-3.5 text-done" />
          ) : approval.status === "denied" ? (
            <X className="size-3.5" />
          ) : (
            <CircleDashed className="size-3.5" />
          )}
          {approval.status === "approved"
            ? "Approved"
            : approval.status === "denied"
              ? "Denied"
              : "Expired"}
          {approval.decidedAt && <TimeAgo date={approval.decidedAt} />}
          <span aria-hidden>·</span>
          <span className="truncate">{bot?.name ?? "Former teammate"}</span>
        </span>
      </div>
      <OpenChat chatId={approval.chatId} />
    </li>
  );
}

export function ApprovalsView() {
  const { data, isLoading } = useApprovals();
  const { data: state } = useAppState();
  const botFor = (approval: ApprovalView) => state?.bots.find((b) => b.id === approval.botId);
  const pending = (data ?? []).filter((approval) => approval.status === "pending");
  // Most recently decided first, the way the phone lists them.
  const decided = (data ?? [])
    .filter((approval) => approval.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  if (isLoading) return <Skeleton className="h-40 w-full max-w-[880px] rounded-xl" />;
  // One reading width for the cards and the details inside them.
  return (
    <div className="flex max-w-[880px] flex-col gap-10">
      {pending.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
          <ShieldCheck className="size-6 text-muted-foreground" />
          <p className="font-medium">Nothing to approve</p>
          <p className="max-w-sm text-[13.5px] text-muted-foreground">
            Teammates ask here before sending, posting, buying or deleting anything. Set how careful
            each one is in their profile.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((approval) => (
            <PendingApproval key={approval.id} approval={approval} bot={botFor(approval)} />
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Decided
          </h2>
          <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
            {decided.map((approval) => (
              <DecidedApproval key={approval.id} approval={approval} bot={botFor(approval)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
