"use client";

import type { ModelRequestSummary } from "@open-bot/api";
import { compactNumber } from "@open-bot/domain";
import { format } from "date-fns";
import { AlertTriangle, ChevronDown, Hourglass, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { between, formatCost, requestKindLabel } from "../format";
import { RequestBodies } from "./request-bodies";
import { ToolCallList } from "./tool-calls";

const time = (iso: string) => format(new Date(iso), "h:mm:ss a");

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[13px] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Facts({ request }: { request: ModelRequestSummary }) {
  const ttfb = between(request.startedAt, request.firstByteAt);
  const took = between(request.startedAt, request.endedAt);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      <Fact label="Started">{format(new Date(request.startedAt), "MMM d, h:mm:ss.SSS a")}</Fact>
      <Fact label="First byte">{ttfb ? `After ${ttfb}` : "None"}</Fact>
      <Fact label="Took">{took ?? "Never finished"}</Fact>
      <Fact label="Access">
        {request.route === "api" ? "API key" : request.route === "plan" ? "ChatGPT plan" : "Direct"}
        {" · "}
        {request.transport === "websocket" ? "WebSocket" : "HTTP"}
      </Fact>
      <Fact label="Endpoint">
        <span className="font-mono text-[12.5px]">
          {request.method} {request.endpoint}
        </span>
      </Fact>
      <Fact label="Status">
        {request.status ?? "No answer"}
        {request.stopReason ? ` · ${request.stopReason}` : ""}
      </Fact>
      <Fact label="Tokens">
        {compactNumber(request.inputTokens ?? 0)} in,{" "}
        {compactNumber(request.cachedInputTokens ?? 0)} cached,{" "}
        {compactNumber(request.outputTokens ?? 0)} out
        {request.reasoningTokens ? `, ${compactNumber(request.reasoningTokens)} reasoning` : ""}
      </Fact>
      <Fact label="Cost">
        {request.route === "plan" ? "On your plan" : formatCost(request.costMicros)}
      </Fact>
      <Fact label="Items">
        {request.inputItems} in, {request.outputItems} out
        {request.sentInputFrom !== null ? ` · sent from #${request.sentInputFrom}` : ""}
      </Fact>
    </dl>
  );
}

function RateLimits({ limits }: { limits: Record<string, string> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-[12.5px] font-medium text-muted-foreground">Rate limits</h4>
      <dl className="grid min-w-0 grid-cols-[minmax(0,max-content)_auto] justify-start gap-x-4 gap-y-0.5 font-mono text-[12px]">
        {Object.entries(limits)
          // Stored as JSON, whose keys come back in no useful order.
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="truncate text-muted-foreground">{name}</dt>
              <dd className="whitespace-nowrap">{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

/** One model request: what it was and how it went, its tool calls, and its bodies when opened. */
export function RequestCard({ request, index }: { request: ModelRequestSummary; index: number }) {
  const [open, setOpen] = useState(false);
  const took = between(request.startedAt, request.endedAt);
  const tokens =
    request.inputTokens !== null || request.outputTokens !== null
      ? `${compactNumber(request.inputTokens ?? 0)} in · ${compactNumber(request.outputTokens ?? 0)} out`
      : null;
  const calls = request.toolCalls.length;
  const facts = [
    time(request.startedAt),
    took,
    tokens,
    request.costMicros > 0 ? formatCost(request.costMicros) : null,
    calls > 0 ? (calls === 1 ? "1 tool call" : `${calls} tool calls`) : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card",
        request.failed && "border-destructive/30",
      )}
      data-testid="model-request"
      data-kind={request.kind ?? "request"}
      data-failed={request.failed || undefined}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-w-0 flex-col gap-1 rounded-xl px-4 py-3 text-left transition-colors hover:bg-subtle/60"
        data-testid="model-request-toggle"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="text-[12.5px] text-muted-foreground tabular-nums">{index}</span>
          <span className="text-[14px] font-semibold">{requestKindLabel(request.kind)}</span>
          {request.model && (
            <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">
              {request.model}
            </span>
          )}
          {request.retryOf && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-subtle px-2 py-px text-[11.5px] text-muted-foreground">
              <RotateCcw className="size-3" />
              Retry
            </span>
          )}
          {request.bodiesExpiredAt && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-subtle px-2 py-px text-[11.5px] text-muted-foreground">
              <Hourglass className="size-3" />
              Expired
            </span>
          )}
          {request.failed && (
            <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-px text-[11.5px] font-medium text-destructive">
              Failed{request.status ? ` · ${request.status}` : ""}
            </span>
          )}
          <ChevronDown
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground tabular-nums">
          {/* Each part stays whole when the line wraps, with its separator after it. */}
          {facts.map((fact, i) => (
            <span key={`${i}-${fact}`} className="whitespace-nowrap">
              {fact}
              {i < facts.length - 1 && " ·"}
            </span>
          ))}
        </span>
      </button>
      {(request.failed && (request.errorMessage || request.errorType)) ||
      request.parseWarnings.length ||
      request.turnMatch === "time" ? (
        <div className="flex flex-col gap-1 px-4 pb-2 text-[12.5px]">
          {request.failed && (request.errorMessage || request.errorType) && (
            <p className="text-destructive [overflow-wrap:anywhere]">
              {request.errorType ? `${request.errorType}: ` : ""}
              {request.errorMessage}
            </p>
          )}
          {request.parseWarnings.map((warning) => (
            <p
              key={warning}
              className="flex items-start gap-1.5 text-muted-foreground [overflow-wrap:anywhere]"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {warning}
            </p>
          ))}
          {request.turnMatch === "time" && (
            <p className="text-muted-foreground">
              Codex named no turn for this request, so it is placed here by when it started.
            </p>
          )}
        </div>
      ) : null}
      {calls > 0 && (
        <div className="border-t px-2 py-1.5">
          <ToolCallList calls={request.toolCalls} />
        </div>
      )}
      {open && (
        <div
          className="flex min-w-0 flex-col gap-5 border-t px-4 py-4"
          data-testid="model-request-details"
        >
          <Facts request={request} />
          {request.rateLimits && <RateLimits limits={request.rateLimits} />}
          {request.bodiesExpiredAt ? (
            <p className="text-[13px] text-muted-foreground" data-testid="request-expired">
              What it sent and what came back expired on{" "}
              {format(new Date(request.bodiesExpiredAt), "MMM d, yyyy")}, under your retention
              setting. The numbers above stay.
            </p>
          ) : (
            <RequestBodies requestId={request.id} />
          )}
        </div>
      )}
    </li>
  );
}
