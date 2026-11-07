"use client";

import {
  commandSummary,
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
  CalendarDays,
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
  CreditCard,
  Mail,
  NotebookText,
  Sparkles,
  SquareTerminal,
  Undo2,
  UserRound,
  Webhook,
  Wrench,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { TakeOverButton, useComputer } from "@/components/computer/computer-panel";
import {
  ApprovalIcon,
  ApprovalReview,
  ApprovalTitle,
  NEEDS_YOU_SURFACE,
  RiskChip,
  riskOf,
  type ApprovalSubject,
} from "@/components/approvals/approval-parts";
import { MessageText } from "./message-text";
import { Button } from "@/components/ui/button";
import { dismissTakeoverRequest } from "@/lib/actions";
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
  wrap = false,
}: {
  icon: ReactNode;
  summary: ReactNode;
  detail?: ReactNode;
  running?: boolean;
  failed?: boolean;
  defaultOpen?: boolean;
  /** The summary ends in an outcome worth reading in full: it wraps to a second line. */
  wrap?: boolean;
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
          "group flex min-h-7 gap-2 rounded-md text-left text-[13px] text-muted-foreground transition-colors",
          wrap ? "items-start py-[5px] leading-[18px]" : "items-center",
          expandable && "hover:text-foreground",
          failed && "text-destructive",
        )}
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
            wrap && "mt-px",
          )}
        >
          {running ? <Loader2 className="animate-spin" /> : icon}
        </span>
        <span className={cn("min-w-0 flex-1", wrap ? "line-clamp-2 text-pretty" : "truncate")}>
          {summary}
        </span>
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

/** A shell command: what it does in plain words, then the command itself in a code face. */
export function CommandStep({ item, approved = false }: { item: CommandItem; approved?: boolean }) {
  const command = shellScript(item.command);
  const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
  return (
    <Step
      icon={<SquareTerminal />}
      running={item.status === "running"}
      failed={failed && item.status !== "running"}
      summary={
        // What it did always shows in full; the raw command gets what room is left, on one line.
        // The whole command is in the detail.
        <span className="flex min-w-0 items-baseline">
          <span className="max-w-full shrink-0 truncate">
            <span className={cn(!failed && "text-foreground/85")}>
              {commandSummary(item.command)}
            </span>
            {failed && item.exitCode !== null && (
              <span className="ml-1.5">· didn&apos;t work (exit {item.exitCode})</span>
            )}
            {approved && (
              <span className="ml-1.5 inline-flex items-center gap-1 text-muted-foreground">
                · <Check className="size-3 text-done" aria-hidden />
                you approved
              </span>
            )}
          </span>
          <span
            className="ml-2 min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint"
            data-testid="step-command"
          >
            {command.replace(/\s+/g, " ")}
          </span>
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
  watch_gmail: Mail,
  watch_calendar: CalendarDays,
  search_history: History,
  save_skill: Sparkles,
  remember_about_user: UserRound,
  model_fallback: KeyRound,
  vault_fill: KeyRound,
  start_purchase: CreditCard,
  finish_purchase: CreditCard,
};

/** Account tools are named by namespace: `gmail.search`, `calendar.create_event`. */
const NAMESPACE_ICONS: Record<string, typeof Wrench> = {
  gmail: Mail,
  calendar: CalendarDays,
  notion: NotebookText,
};

export function ToolStep({ item }: { item: ToolItem }) {
  const Icon = TOOL_ICONS[item.name] ?? NAMESPACE_ICONS[item.name.split(".")[0]!] ?? Wrench;
  return (
    <Step
      icon={<Icon />}
      running={item.status === "running"}
      failed={item.status === "failed"}
      wrap
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
    <div className="rounded-xl bg-card shadow-raised px-4 py-3">
      <div className="mb-2 text-[12.5px] font-medium text-muted-foreground">Plan</div>
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
      wrap
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
  const approval: ApprovalSubject = { ...item, kind: item.approvalKind ?? "action" };
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
          : <ApprovalTitle approval={approval} showCommand />
        </span>
      </div>
    );
  }
  const risk = riskOf(approval);
  return (
    <div
      className={cn("flex flex-col gap-3 rounded-xl p-4", NEEDS_YOU_SURFACE)}
      data-testid="approval-card"
    >
      {/* One mark beside the title, the risk chip's triangle, as on the phone. Without a risk,
          the kind of action leads instead. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        {!risk && (
          <ApprovalIcon approval={approval} className="size-4 shrink-0 text-attention-ink" />
        )}
        <span className="text-[14.5px] leading-snug font-medium">
          <ApprovalTitle approval={approval} />
        </span>
        {risk && <RiskChip risk={risk} />}
      </div>
      <ApprovalReview approvalId={item.approvalId} approval={approval} botName={botName} />
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
  const { screen, online } = useComputer();
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
      className="flex flex-col gap-3 rounded-xl border border-attention/40 bg-attention/[0.07] p-4"
      data-testid="takeover-request"
    >
      <div className="flex items-start gap-2.5">
        <Hand className="mt-0.5 size-4 shrink-0 text-attention-ink" />
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-medium">{botName} needs you to take over</span>
          <span className="text-[13px] text-muted-foreground">{item.reason}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-6.5">
        {youHaveControl || item.resolution === "taken" ? (
          <span className="text-[13px] text-attention-ink">
            You have control of {botName}&apos;s screen. Hand it back when you&apos;re done.
          </span>
        ) : (
          <>
            {online ? (
              <TakeOverButton screenId={botId} size="sm" />
            ) : (
              <span className="mr-1 text-[13px] text-muted-foreground">
                You can take over once the computer is back.
              </span>
            )}
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
      <div className="flex items-center gap-2 self-start rounded-full bg-subtle px-3 py-1 text-[12.5px] text-muted-foreground">
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
