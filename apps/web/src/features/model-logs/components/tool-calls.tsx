"use client";

import type { NestedOutcomeView, ToolCallView, ToolOutcomeView } from "@open-bot/api";
import { formatDuration } from "@open-bot/domain";
import { ChevronRight, Code2, FileDiff, Globe, Plug, SquareTerminal, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toolItemLabel } from "../format";
import { ClampedText } from "./text-block";

const TONE = {
  ok: { dot: "bg-done", text: "text-done" },
  error: { dot: "bg-destructive", text: "text-destructive" },
  working: { dot: "bg-working", text: "text-working" },
  unknown: { dot: "bg-idle", text: "text-muted-foreground" },
} as const;

const STATUS_WORDS: Record<string, string> = {
  completed: "Done",
  failed: "Failed",
  declined: "Declined",
  inProgress: "Started",
  in_progress: "Started",
  started: "Started",
};

/** An outcome in a word or two: the exit code for a command, else its status. */
function outcomeWords(outcome: ToolOutcomeView): string {
  if (outcome.omitted) return "Result not stored";
  if (outcome.exitCode !== null) return `Exit ${outcome.exitCode}`;
  if (outcome.tone === "error" && !outcome.status) return "Failed";
  return (outcome.status && STATUS_WORDS[outcome.status]) ?? outcome.status ?? "Done";
}

export function OutcomeChip({ outcome }: { outcome: ToolOutcomeView | null }) {
  if (!outcome)
    return <span className="text-[12px] whitespace-nowrap text-muted-foreground">No outcome</span>;
  const tone = TONE[outcome.tone];
  return (
    <span className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      <span className={cn("font-medium", tone.text)}>{outcomeWords(outcome)}</span>
      {outcome.durationMs !== null && (
        <span className="text-muted-foreground">
          {outcome.durationMs < 1000
            ? `${outcome.durationMs} ms`
            : formatDuration(outcome.durationMs)}
        </span>
      )}
    </span>
  );
}

function iconFor(type: string, name: string) {
  if (name === "exec" && type === "custom_tool_call") return Code2;
  if (type === "commandExecution" || type === "local_shell_call" || /command|shell/.test(name))
    return SquareTerminal;
  if (type === "fileChange" || /patch|edit|write/.test(name)) return FileDiff;
  if (type === "webSearch" || type === "web_search_call") return Globe;
  if (type === "mcpToolCall" || type === "mcp_call") return Plug;
  return Wrench;
}

/** A labeled block inside an expanded call. */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

const OUTPUT_REST = "Its full message is under Codex messages.";

function OutcomeDetails({ outcome }: { outcome: ToolOutcomeView }) {
  return (
    <>
      {outcome.omitted && (
        <p className="text-[13px] text-muted-foreground">
          Codex&apos;s message with its result was not stored: {outcome.omitted}.
        </p>
      )}
      {outcome.error && (
        <Part label="Error">
          <ClampedText text={outcome.error} mono className="text-destructive" />
        </Part>
      )}
      {outcome.output !== null && outcome.output !== "" && (
        <Part label="Output">
          <ClampedText text={outcome.output} chars={outcome.outputChars} rest={OUTPUT_REST} mono />
        </Part>
      )}
    </>
  );
}

function Row({
  icon: Icon,
  name,
  detail,
  trailing,
  open,
  onToggle,
  testId,
  plain = false,
}: {
  icon: typeof Wrench;
  name: string;
  /** The name is words, not code. */
  plain?: boolean;
  detail: string | null;
  trailing: ReactNode;
  open: boolean;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-testid={testId}
      // On a phone the outcome goes on its own line under the name, so the name keeps its room.
      className="grid w-full min-w-0 grid-cols-[auto_auto_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-subtle sm:flex"
    >
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className={cn("shrink-0 font-medium", plain ? "text-[13px]" : "font-mono text-[12.5px]")}
      >
        {name}
      </span>
      {detail && (
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
          {detail}
        </span>
      )}
      <span className="col-span-full flex min-w-0 pl-[44px] sm:ml-auto sm:shrink-0 sm:pl-2">
        {trailing}
      </span>
    </button>
  );
}

/** The first line of a text, for a one-line summary. */
function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.trim().split("\n")[0]!;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function NestedRow({ outcome }: { outcome: NestedOutcomeView }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex min-w-0 flex-col">
      <Row
        icon={iconFor(outcome.type, "")}
        name={toolItemLabel(outcome.type)}
        plain
        detail={firstLine(outcome.title)}
        trailing={
          <span className="flex items-center gap-2">
            <span
              className="rounded bg-subtle px-1.5 py-px text-[11px] whitespace-nowrap text-muted-foreground"
              title={
                outcome.match === "ambiguous"
                  ? `${outcome.candidates} code cells were running when it started, so it could be from any of them.`
                  : "The only code cell running when it started, so most likely this one. The logs don't record it."
              }
              data-testid="nested-match"
            >
              {outcome.match === "ambiguous"
                ? `Uncertain, 1 of ${outcome.candidates} calls`
                : "Likely, by time"}
            </span>
            <OutcomeChip outcome={outcome} />
          </span>
        }
        open={open}
        onToggle={() => setOpen((value) => !value)}
        testId="nested-tool"
      />
      {open && (
        <div className="ml-6 flex flex-col gap-3 border-l py-2 pl-4">
          <Part label={outcome.type === "commandExecution" ? "Command" : "What it did"}>
            <ClampedText text={outcome.title} mono />
          </Part>
          <OutcomeDetails outcome={outcome} />
        </div>
      )}
    </li>
  );
}

function ToolCallRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const isExec = call.name === "exec" && call.type === "custom_tool_call";
  const detail = firstLine(call.outcome?.title ?? call.arguments?.text);
  const trailing =
    isExec && !call.outcome ? (
      <span className="text-[12px] whitespace-nowrap text-muted-foreground">
        {call.nested.length === 1 ? "1 nested call" : `${call.nested.length} nested calls`}
      </span>
    ) : (
      <OutcomeChip outcome={call.outcome} />
    );
  return (
    <li className="flex min-w-0 flex-col" data-testid="tool-call">
      <Row
        icon={iconFor(call.type, call.name)}
        name={call.namespace ? `${call.namespace}.${call.name}` : call.name}
        detail={detail}
        trailing={trailing}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        testId="tool-call-toggle"
      />
      {open && (
        <div className="ml-6 flex flex-col gap-3 border-l py-2 pl-4">
          {call.arguments && (
            <Part label={isExec ? "Code" : "Arguments"}>
              <ClampedText
                text={call.arguments.text}
                chars={call.arguments.chars}
                rest="Open the request's response for all of it."
                mono
              />
            </Part>
          )}
          {call.outcome && <OutcomeDetails outcome={call.outcome} />}
          {call.returned && (
            <Part label="Sent back to the model">
              <ClampedText
                text={call.returned.text}
                chars={call.returned.chars}
                rest="The next request's input has all of it."
                mono
              />
            </Part>
          )}
          {!call.outcome && !call.returned && !isExec && (
            <p className="text-[13px] text-muted-foreground">
              Nothing in the logs shows how this call went.
            </p>
          )}
        </div>
      )}
      {isExec && call.nested.length > 0 && (
        <div className="ml-6 border-l pl-2">
          <p className="px-2 pt-1 text-[12px] text-muted-foreground">
            Matched by time: Codex doesn&apos;t record which code cell made each call.
          </p>
          <ul className="flex flex-col">
            {call.nested.map((outcome) => (
              <NestedRow key={outcome.itemId} outcome={outcome} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** A request's tool calls, each with its outcome; open one for its arguments and output. */
export function ToolCallList({ calls }: { calls: ToolCallView[] }) {
  return (
    <ul className="flex min-w-0 flex-col" data-testid="tool-calls">
      {calls.map((call) => (
        <ToolCallRow key={`${call.position}`} call={call} />
      ))}
    </ul>
  );
}

/** Tool items the logs show no call for. */
export function UnlinkedTools({ outcomes }: { outcomes: ToolOutcomeView[] }) {
  return (
    <ul className="flex min-w-0 flex-col">
      {outcomes.map((outcome) => (
        <UnlinkedRow key={outcome.itemId} outcome={outcome} />
      ))}
    </ul>
  );
}

function UnlinkedRow({ outcome }: { outcome: ToolOutcomeView }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex min-w-0 flex-col">
      <Row
        icon={iconFor(outcome.type, "")}
        name={toolItemLabel(outcome.type)}
        plain
        detail={firstLine(outcome.title)}
        trailing={<OutcomeChip outcome={outcome} />}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        testId="unlinked-tool"
      />
      {open && (
        <div className="ml-6 flex flex-col gap-3 border-l py-2 pl-4">
          <Part label="What it did">
            <ClampedText text={outcome.title} mono />
          </Part>
          <OutcomeDetails outcome={outcome} />
        </div>
      )}
    </li>
  );
}
