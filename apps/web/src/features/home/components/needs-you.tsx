"use client";

import { approvalShortTitle } from "@open-bot/domain";
import { ArrowRight, Hand, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useApprovals } from "@/features/approvals";
import { useAppState } from "@/features/app-shell";
import { isComputerOnline } from "@/lib/status";
import type { AppState, TakeoverRequestSummary } from "@/lib/types";
import { chatHref } from "@/lib/utils";

/** The amber row of something you can act on. */
const NEEDS_ROW =
  "flex items-start gap-3 rounded-xl border border-attention/40 bg-attention/[0.07] px-4 py-3 transition-colors hover:bg-attention/[0.12]";

/** The most approvals listed one by one; the rest are on the approvals page. */
const APPROVALS_SHOWN = 3;

/** Each pending approval on its own row: what it does, with the amount or recipient, and who asks. */
function ApprovalRows({ state }: { state: AppState }) {
  const { data } = useApprovals();
  const pending = (data ?? []).filter((approval) => approval.status === "pending");
  // Until the list agrees with the count, one row stands for them all.
  if (pending.length !== state.pendingApprovals)
    return (
      <Link href="/approvals" className={NEEDS_ROW} data-testid="home-approvals">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-attention-ink" />
        <span className="flex-1 text-[14px] font-medium">
          {state.pendingApprovals === 1
            ? "1 action needs your approval"
            : `${state.pendingApprovals} actions need your approval`}
        </span>
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </Link>
    );
  const more = pending.length - APPROVALS_SHOWN;
  return (
    <>
      {pending.slice(0, APPROVALS_SHOWN).map((approval) => {
        const teammate = state.teammates.find((entry) => entry.id === approval.teammateId);
        const title = approvalShortTitle({
          ...approval,
          previewType: approval.preview?.type ?? null,
        });
        return (
          <Link
            key={approval.id}
            href={chatHref(approval.chatId, approval.runId)}
            className={NEEDS_ROW}
            data-testid="home-approval"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-attention-ink" />
            <span className="line-clamp-2 min-w-0 flex-1 text-[14px] break-words text-pretty">
              <span className="font-medium">{title}</span>
              {teammate && <span className="text-muted-foreground"> · {teammate.name}</span>}
            </span>
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          </Link>
        );
      })}
      {more > 0 && (
        <Link
          href="/approvals"
          className="flex items-center gap-1 self-start px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {more} more {more === 1 ? "approval" : "approvals"}
          <ArrowRight className="size-3.5" />
        </Link>
      )}
    </>
  );
}

/**
 * A teammate asks you to take over their screen. While the computer is online you can, so it is
 * an amber row like an approval. While it is offline you can't yet: a lighter card with when you
 * can, after what you can act on now.
 */
function TakeoverRow({ request, online }: { request: TakeoverRequestSummary; online: boolean }) {
  const href = `/computer?screen=${request.screenId}`;
  if (online)
    return (
      <Link href={href} className={NEEDS_ROW} data-testid="home-takeover-request">
        <Hand className="mt-0.5 size-4 shrink-0 text-attention-ink" />
        <span className="line-clamp-2 min-w-0 flex-1 text-[14px] break-words text-pretty">
          <span className="font-medium">{request.teammateName} needs you to take over:</span>{" "}
          <span className="text-muted-foreground">{request.reason}</span>
        </span>
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </Link>
    );
  return (
    <div
      className="flex items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-raised"
      data-testid="home-takeover-request"
    >
      <Hand className="mt-0.5 size-4 shrink-0 text-attention-ink" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium">
          {request.teammateName} needs you to take over
        </span>
        <span className="line-clamp-2 text-[13px] break-words text-pretty text-muted-foreground">
          {request.reason}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[12.5px] text-muted-foreground">
            You can take over once the computer is back.
          </span>
          <Link
            href={href}
            className="flex items-center gap-1 text-[13px] font-medium text-foreground/85 transition-colors hover:text-foreground"
          >
            View request
            <ArrowRight className="size-3.5" />
          </Link>
        </span>
      </div>
    </div>
  );
}

/**
 * What needs you, and only what you can act on here: each approval, then each take over request
 * (first instead while the computer is online, since then it's the most urgent). The number in the
 * line under the greeting counts exactly these rows.
 */
export function NeedsYou() {
  const { data: state } = useAppState();
  if (!state) return null;
  const online = isComputerOnline(state);
  const requests = state.takeoverRequests;
  if (state.pendingApprovals === 0 && requests.length === 0) return null;
  const approvals = state.pendingApprovals > 0 && <ApprovalRows state={state} />;
  const takeovers = requests.map((request) => (
    <TakeoverRow key={request.id} request={request} online={online} />
  ));
  return (
    <section className="flex flex-col gap-2.5" aria-label="Needs you">
      <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        Needs you
      </h2>
      <div className="flex flex-col gap-2">
        {online ? (
          <>
            {takeovers}
            {approvals}
          </>
        ) : (
          <>
            {approvals}
            {takeovers}
          </>
        )}
      </div>
    </section>
  );
}
