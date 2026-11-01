"use client";

import {
  shellScript,
  type ApprovalItem,
  type CommandItem,
  type FileChangeItem,
  type HandoffItem,
  type PlanItem,
  type ReasoningItem,
  type TakeoverRequestItem,
  type ToolItem,
  type UserMessageItem,
  type WebSearchItem,
} from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Eye,
  FilePen,
  Hand,
  History,
  KeyRound,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Search,
  ShieldAlert,
  CreditCard,
  Mail,
  Sparkles,
  SquareTerminal,
  Undo2,
  UserRound,
  Webhook,
  Wrench,
  X,
} from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { TakeOverButton, useComputer } from "@/components/computer/computer-panel";
import { AlwaysAllowButton } from "@/components/approvals/always-allow";
import { approvalDetail, InlineCode } from "@/components/inline-code";
import { MessageText } from "./message-text";
import { Button } from "@/components/ui/button";
import { decideApproval, dismissTakeoverRequest } from "@/lib/actions";
import { queryKeys } from "@/lib/client/queries";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

/** A collapsible step row: icon, one-line summary, optional detail. */
function Step({
  icon,
  summary,
  detail,
  running,
  failed,
  defaultOpen = false,
}: {
  icon: ReactNode;
  summary: ReactNode;
  detail?: ReactNode;
  running?: boolean;
  failed?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Boolean(detail);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "group flex min-h-7 items-center gap-2 rounded-md text-left text-[13px] text-muted-foreground transition-colors",
          expandable && "hover:text-foreground",
          failed && "text-destructive",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
          {running ? <Loader2 className="animate-spin" /> : icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {expandable && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        )}
      </button>
      {open && detail && <div className="mt-1 mb-2 ml-6">{detail}</div>}
    </div>
  );
}

export function ReasoningStep({ item }: { item: ReasoningItem }) {
  const running = item.status === "running";
  const firstLine =
    item.text
      .split("\n")
      .find((line) => line.trim())
      ?.replace(/\*\*/g, "") ?? "Thinking";
  return (
    <Step
      icon={<CircleDashed />}
      running={running}
      summary={<span className="italic">{firstLine}</span>}
      detail={
        item.text.includes("\n") ? (
          <Markdown text={item.text} className="text-[13px] text-muted-foreground" />
        ) : undefined
      }
    />
  );
}

export function CommandStep({ item }: { item: CommandItem }) {
  const command = shellScript(item.command);
  const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
  return (
    <Step
      icon={<SquareTerminal />}
      running={item.status === "running"}
      failed={failed && item.status !== "running"}
      summary={
        <span className="font-mono text-[12.5px]">
          {command}
          {failed && item.exitCode !== null && (
            <span className="ml-2 font-sans">exit {item.exitCode}</span>
          )}
        </span>
      }
      detail={
        <pre className="max-h-72 overflow-auto rounded-lg bg-subtle px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/85">
          <span className="text-muted-foreground">$ {command}</span>
          {"\n"}
          {item.output.trim() || <span className="text-muted-foreground">(no output)</span>}
        </pre>
      }
    />
  );
}

function diffStats(diff: string) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export function FileChangeStep({ item }: { item: FileChangeItem }) {
  const name = (path: string) => path.split("/").slice(-2).join("/");
  const verb = item.changes.every((c) => c.change === "add")
    ? "Created"
    : item.changes.every((c) => c.change === "delete")
      ? "Deleted"
      : "Edited";
  return (
    <Step
      icon={<FilePen />}
      running={item.status === "running"}
      failed={item.status === "failed"}
      summary={
        <>
          {verb}{" "}
          <span className="font-mono text-[12.5px]">
            {item.changes.map((c) => name(c.path)).join(", ")}
          </span>
          {item.changes.length === 1 && item.changes[0]!.diff && (
            <span className="ml-2 font-mono text-[12px]">
              <span className="text-done">+{diffStats(item.changes[0]!.diff).added}</span>{" "}
              <span className="text-destructive">−{diffStats(item.changes[0]!.diff).removed}</span>
            </span>
          )}
        </>
      }
      detail={
        <div className="flex flex-col gap-2">
          {item.changes.map((change) => (
            <pre
              key={change.path}
              className="max-h-72 overflow-auto rounded-lg bg-subtle px-3 py-2 font-mono text-[12px] leading-relaxed"
            >
              <div className="mb-1 text-muted-foreground">{change.path}</div>
              {change.diff.split("\n").map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    line.startsWith("+") && !line.startsWith("+++") && "bg-done/10 text-done",
                    line.startsWith("-") &&
                      !line.startsWith("---") &&
                      "bg-destructive/10 text-destructive",
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          ))}
        </div>
      }
    />
  );
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  notify_user: Bell,
  send_email: Mail,
  list_emails: Mail,
  schedule_task: CalendarClock,
  cancel_schedule: CalendarClock,
  list_schedules: CalendarClock,
  list_automations: CalendarClock,
  cancel_automation: CalendarClock,
  update_automation: CalendarClock,
  ask_teammate: MessageCircleQuestion,
  list_tasks: ListTodo,
  propose_instructions: Sparkles,
  add_task: ListTodo,
  update_task: ListTodo,
  watch_page: Eye,
  create_webhook: Webhook,
  search_history: History,
  save_skill: Sparkles,
  remember_about_user: UserRound,
  model_fallback: KeyRound,
  vault_fill: KeyRound,
  start_purchase: CreditCard,
  finish_purchase: CreditCard,
};

export function ToolStep({ item }: { item: ToolItem }) {
  const Icon = TOOL_ICONS[item.name] ?? Wrench;
  return (
    <Step
      icon={<Icon />}
      running={item.status === "running"}
      failed={item.status === "failed"}
      summary={
        <>
          <span className="text-foreground/85">{item.label}</span>
          {item.result && <span className="ml-1.5 text-muted-foreground">· {item.result}</span>}
          {item.status === "failed" && item.error && (
            <span className="ml-1.5 text-muted-foreground">· {item.error}</span>
          )}
        </>
      }
    />
  );
}

export function WebSearchStep({ item }: { item: WebSearchItem }) {
  return (
    <Step
      icon={<Search />}
      running={item.status === "running"}
      summary={item.query ? <>Searched the web for “{item.query}”</> : "Searched the web"}
    />
  );
}

export function PlanCard({ item }: { item: PlanItem }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="mb-2 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
        Plan
      </div>
      <ol className="flex flex-col gap-1.5">
        {item.steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2.5 text-[13.5px]">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {step.status === "completed" ? (
                <CircleCheck className="size-4 text-done" />
              ) : step.status === "inProgress" ? (
                <Loader2 className="size-3.5 animate-spin text-foreground" />
              ) : (
                <span className="size-3 rounded-full border border-muted-foreground/50" />
              )}
            </span>
            <span
              className={cn(
                step.status === "completed" &&
                  "text-muted-foreground line-through decoration-muted-foreground/40",
              )}
            >
              {step.step}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HandoffStep({ item }: { item: HandoffItem }) {
  return (
    <Step
      icon={<ArrowRightLeft />}
      summary={
        <>
          Handed to <span className="font-medium text-foreground">{item.toBotName}</span>:{" "}
          {item.message}
        </>
      }
    />
  );
}

export function ApprovalCard({ item, botName }: { item: ApprovalItem; botName: string }) {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const decide = (decision: "approved" | "denied", alwaysAllow?: string) =>
    startTransition(async () => {
      const result = await decideApproval(
        item.approvalId,
        decision,
        alwaysAllow === undefined ? null : { pattern: alwaysAllow },
      );
      if (!result.ok) toast.error(result.error);
      else if (alwaysAllow !== undefined)
        toast("Approved, and allowed from now on", {
          description: `${botName} won't ask about this again.`,
        });
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
    });

  if (item.decision !== "pending") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {item.decision === "approved" ? (
          <Check className="size-3.5 text-done" />
        ) : item.decision === "denied" ? (
          <X className="size-3.5 text-destructive" />
        ) : (
          <CircleDashed className="size-3.5" />
        )}
        <span className="truncate">
          {item.decision === "approved"
            ? "You approved"
            : item.decision === "denied"
              ? "You denied"
              : "Expired"}
          : <InlineCode text={item.title} />
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-waiting/35 bg-waiting/[0.06] p-4"
      data-testid="approval-card"
    >
      <div className="flex items-start gap-2.5">
        {item.approvalKind === "purchase" ? (
          <CreditCard className="mt-0.5 size-4 shrink-0 text-waiting" />
        ) : item.approvalKind === "email" ? (
          <Mail className="mt-0.5 size-4 shrink-0 text-waiting" />
        ) : (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-waiting" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[14px] font-medium">
            Approve: <InlineCode text={item.title} />
          </span>
          {item.detail && (
            <pre className="max-h-60 overflow-auto font-sans text-[13px] whitespace-pre-wrap text-muted-foreground">
              {approvalDetail(item.detail)}
            </pre>
          )}
        </div>
      </div>
      <div className="flex gap-2 pl-6">
        <Button
          size="sm"
          onClick={() => decide("approved")}
          disabled={pending}
          data-testid="approve"
        >
          <Check />
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => decide("denied")}
          disabled={pending}
          data-testid="deny"
        >
          Deny
        </Button>
        {item.approvalKind &&
          item.approvalKind !== "purchase" &&
          item.approvalKind !== "email" &&
          !item.askEveryTime && (
            <AlwaysAllowButton
              kind={item.approvalKind}
              subject={item.subject ?? item.title}
              botName={botName}
              disabled={pending}
              onConfirm={async (pattern) => decide("approved", pattern)}
            />
          )}
      </div>
    </div>
  );
}

export function TakeoverRequestCard({
  item,
  botId,
  botName,
}: {
  item: TakeoverRequestItem;
  botId: string;
  botName: string;
}) {
  const { screen } = useComputer();
  const youHaveControl = screen(botId)?.activity === "you";
  const queryClient = useQueryClient();
  if (item.resolution === "handed_back" || item.resolution === "dismissed") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Undo2 className="size-3.5" />
        <span className="truncate">
          {item.resolution === "dismissed"
            ? `You dismissed ${botName}'s request: ${item.reason}`
            : item.note
              ? `You handed the screen back: “${item.note}”`
              : "You handed the screen back"}
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-manual/40 bg-manual/[0.07] p-4"
      data-testid="takeover-request"
    >
      <div className="flex items-start gap-2.5">
        <Hand className="mt-0.5 size-4 shrink-0 text-manual-ink" />
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-medium">{botName} needs you to take over</span>
          <span className="text-[13px] text-muted-foreground">{item.reason}</span>
        </div>
      </div>
      <div className="flex gap-2 pl-6">
        {youHaveControl || item.resolution === "taken" ? (
          <span className="text-[13px] text-manual-ink">
            You have control of {botName}&apos;s screen. Hand it back when you&apos;re done.
          </span>
        ) : (
          <>
            <TakeOverButton screenId={botId} size="sm" />
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const result = await dismissTakeoverRequest(item.takeoverRequestId);
                if (!result.ok) toast.error(result.error);
                await queryClient.invalidateQueries({ queryKey: queryKeys.state });
              }}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function SteeredMessage({ item }: { item: UserMessageItem }) {
  if (item.variant === "hand_back") {
    return (
      <div className="flex items-center gap-2 self-start rounded-full bg-manual/12 px-3 py-1 text-[12.5px] text-manual-ink">
        <Undo2 className="size-3.5" />
        {item.text ? <>You handed the screen back: “{item.text}”</> : "You handed the screen back"}
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-subtle px-3.5 py-2 text-[14px] whitespace-pre-wrap">
        <MessageText text={item.text} />
      </div>
    </div>
  );
}
