"use client";

import { triggerLabel, type TriggerKind } from "@open-bot/chat-core";
import {
  ArrowRightLeft,
  CalendarClock,
  CalendarDays,
  Eye,
  ListTodo,
  Mail,
  MessageCircleQuestion,
  MessageCircleReply,
  Network,
  ShieldCheck,
  Undo2,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BotSummary, RunView } from "@/lib/types";
import { Markdown } from "./markdown";

/** Each trigger's icon; the words come from `triggerLabel` (packages/chat-core). */
const TRIGGER_ICONS: Record<TriggerKind, typeof CalendarClock> = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
  hand_back: Undo2,
  approval: ShieldCheck,
  handoff: ArrowRightLeft,
  question: MessageCircleQuestion,
  answer: MessageCircleReply,
  task: ListTodo,
  email: Mail,
  swarm: Network,
  swarm_results: Network,
};

/** What started the run: an automation opens what it gave the teammate, a task links the board. */
export function TriggerLabel({ run, bots }: { run: RunView; bots: BotSummary[] }) {
  const label = triggerLabel(run, bots);
  if (!label) return null;
  const Icon = TRIGGER_ICONS[label.kind];
  const content = (
    <>
      <Icon className="size-3.5" />
      {label.text}
    </>
  );
  if (label.automation && run.automationPrompt)
    return (
      <Popover>
        <PopoverTrigger
          className="-mx-1 flex items-center gap-1 rounded-md px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid="automation-label"
        >
          {content}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] gap-2 p-0">
          <div className="border-b px-3.5 py-2.5 text-[12.5px] font-medium text-muted-foreground">
            What started this
          </div>
          <div className="max-h-80 overflow-y-auto px-3.5 pb-3">
            <Markdown text={run.automationPrompt} className="text-[13px]" />
          </div>
        </PopoverContent>
      </Popover>
    );
  if (label.kind === "task")
    return (
      <Link
        href="/tasks"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        data-testid="run-trigger"
      >
        {content}
      </Link>
    );
  return (
    <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
      {content}
    </span>
  );
}
