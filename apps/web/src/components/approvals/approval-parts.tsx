"use client";

import {
  approvalCommand,
  approvalHeadline,
  approvalRisk,
  approveLabel,
  commandParts,
  detailFields,
  ruleAllowed,
  type AccountActionPreview,
  type ApprovalFacts,
  type ApprovalKind,
  type ApprovalRisk,
} from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  CloudOff,
  CreditCard,
  Mail,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { decideApproval } from "@/lib/actions";
import { useAppState } from "@/lib/client/queries";
import { orpc } from "@/lib/client/rpc";
import { isComputerOnline } from "@/lib/status";
import { InlineCode } from "@/components/inline-code";
import { cn } from "@/lib/utils";
import { ActionPreview, emailIsClamped, previewIcon } from "./action-preview";
import { AlwaysAllowButton } from "./always-allow";

/** The surface of an approval waiting on you: the "needs you" amber, kept quiet. */
export const NEEDS_YOU_SURFACE =
  "border border-attention/40 bg-attention/[0.05] dark:bg-attention/[0.06]";

/** What an approval is, in the shape the display helpers take. */
export interface ApprovalSubject {
  kind: ApprovalKind;
  title: string;
  detail: string;
  subject?: string | null;
  askEveryTime?: boolean;
  preview?: AccountActionPreview | null;
}

export function approvalFacts(approval: ApprovalSubject): ApprovalFacts {
  return {
    kind: approval.kind,
    title: approval.title,
    detail: approval.detail,
    subject: approval.subject,
    previewType: approval.preview?.type ?? null,
  };
}

/** The icon for what an approval does: mail, a card, a calendar, or a plain shield. */
export function ApprovalIcon({
  approval,
  className,
}: {
  approval: ApprovalSubject;
  className?: string;
}) {
  const Icon =
    previewIcon(approval.preview) ??
    (approval.kind === "purchase" ? CreditCard : approval.kind === "email" ? Mail : ShieldAlert);
  return <Icon className={className} />;
}

/** A few words on what's at stake: "Spends money", "Sends an email", "Can't be undone". */
export function RiskChip({ risk, className }: { risk: ApprovalRisk; className?: string }) {
  // One mark for "at stake" everywhere, as on the phone: the triangle.
  return (
    <span
      title={risk.text}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium whitespace-nowrap",
        // A surface fill keeps the chip readable on the amber card it usually sits on.
        "border bg-surface",
        risk.tone === "destructive"
          ? "border-destructive/45 text-destructive"
          : "border-attention/60 text-attention-ink",
        className,
      )}
      data-testid="risk-chip"
    >
      <TriangleAlert className="size-3" />
      {risk.label}
    </span>
  );
}

export function riskOf(approval: ApprovalSubject) {
  return approvalRisk(approvalFacts(approval));
}

/**
 * An approval's title. A command leads with what it does, "Push the fix/x branch"; with
 * `showCommand`, the command itself follows on the same line in a code face, cut short when long.
 * (A pending approval shows the command in full in its detail instead.)
 */
export function ApprovalTitle({
  approval,
  showCommand,
}: {
  approval: ApprovalSubject;
  showCommand?: boolean;
}) {
  const { title, command } = approvalHeadline(approvalFacts(approval));
  if (!command) return <InlineCode text={title} />;
  if (!showCommand) return <>{title}</>;
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline gap-2 align-bottom">
      <span className="shrink-0">{title}</span>
      <code
        className="min-w-0 truncate font-mono text-[0.86em] font-normal text-muted-foreground"
        title={command}
      >
        {command}
      </code>
    </span>
  );
}

/**
 * What approving does, laid out to check at a glance: an account action's exact preview,
 * a command as code, or labeled rows (Out, Back, Card) for details written as "Label: value".
 */
export function ApprovalDetail({
  approval,
  emailOpen,
  onEmailOpenChange,
  className,
}: {
  approval: ApprovalSubject;
  emailOpen?: boolean;
  onEmailOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  if (approval.preview)
    return (
      <ActionPreview
        preview={approval.preview}
        emailOpen={emailOpen}
        onEmailOpenChange={onEmailOpenChange}
        className={className}
      />
    );
  const detail = approval.detail.trim();
  if (!detail && approval.kind !== "command") return null;

  const facts = approvalFacts(approval);
  if (facts.kind === "command" || detail.split("\n").some((line) => line.startsWith("$ "))) {
    // The command in full: the title shows it on one line, cut short when it's long.
    const parts = commandParts(detail);
    const command = parts.command ?? approvalCommand(facts);
    const { reason, cwd } = parts;
    return (
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        {reason && (
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground/85">
            {reason}
          </p>
        )}
        {command && (
          <pre className="max-h-60 overflow-auto rounded-lg border bg-card px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground">
            {command}
          </pre>
        )}
        {cwd && <span className="text-[12.5px] text-muted-foreground">in {cwd}</span>}
      </div>
    );
  }

  const { text, fields } = detailFields(detail);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-lg border bg-card px-3.5 py-3 text-[13.5px]",
        className,
      )}
      data-testid="approval-detail"
    >
      {text.length > 0 && (
        <p className="leading-relaxed whitespace-pre-wrap text-foreground/90">{text.join("\n")}</p>
      )}
      {fields.length > 0 && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-[13px] text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Deny, approve, or approve and allow from now on. The secondary choice sits left and the
 * primary right, as on the phone, and the approve button says what happens. With `onReview`,
 * there's more to read first (a long email), so the primary action reads it.
 */
export function ApprovalDecision({
  approvalId,
  approval,
  botName,
  onReview,
  className,
}: {
  approvalId: string;
  approval: ApprovalSubject;
  botName: string;
  onReview?: () => void;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const { data: state } = useAppState();
  // Deciding works offline; an approved action just waits for the computer.
  const offline = Boolean(state) && !isComputerOnline(state);
  const decide = (decision: "approved" | "denied", alwaysAllow?: string) =>
    startTransition(async () => {
      const result = await decideApproval(
        approvalId,
        decision,
        alwaysAllow === undefined ? null : { pattern: alwaysAllow },
      );
      if (!result.ok) toast.error(result.error);
      else if (alwaysAllow !== undefined)
        toast("Approved, and allowed from now on", {
          description: `${botName} won't ask about this again.`,
        });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.approvals.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.app.state.key() }),
      ]);
    });

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button
        size="lg"
        variant="outline"
        className="px-3.5"
        onClick={() => decide("denied")}
        disabled={pending}
        data-testid="deny"
      >
        Deny
      </Button>
      {onReview ? (
        <Button size="lg" className="px-3.5" onClick={onReview} data-testid="review">
          <ChevronDown />
          Review full email
        </Button>
      ) : (
        <Button
          size="lg"
          className="px-3.5"
          onClick={() => decide("approved")}
          disabled={pending}
          data-testid="approve"
        >
          <Check />
          {approveLabel(approvalFacts(approval))}
        </Button>
      )}
      {ruleAllowed(approval.kind) && !approval.askEveryTime && (
        <AlwaysAllowButton
          kind={approval.kind}
          subject={approval.subject ?? approval.title}
          botName={botName}
          disabled={pending}
          onConfirm={async (pattern) => decide("approved", pattern)}
        />
      )}
      {offline && (
        <span
          className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground sm:ml-1"
          data-testid="approval-offline"
        >
          <CloudOff className="size-3.5 shrink-0" />
          Approved actions run when the computer is back.
        </span>
      )}
    </div>
  );
}

/**
 * What a pending approval does and the decision under it. A long email is cut to its first
 * lines; until it's read in full, the primary action is "Review full email", which opens it in
 * place, so the approve button ends up at the end of the message.
 */
export function ApprovalReview({
  approvalId,
  approval,
  botName,
}: {
  approvalId: string;
  approval: ApprovalSubject;
  botName: string;
}) {
  const [emailOpen, setEmailOpen] = useState(false);
  const unread = emailIsClamped(approval.preview) && !emailOpen;
  return (
    <>
      <ApprovalDetail approval={approval} emailOpen={emailOpen} onEmailOpenChange={setEmailOpen} />
      <ApprovalDecision
        approvalId={approvalId}
        approval={approval}
        botName={botName}
        onReview={unread ? () => setEmailOpen(true) : undefined}
      />
    </>
  );
}
