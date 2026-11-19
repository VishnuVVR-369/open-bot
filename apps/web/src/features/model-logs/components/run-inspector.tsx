"use client";

import type { ModelLogTurn, RunModelLogs } from "@open-bot/api";
import { compactNumber } from "@open-bot/domain";
import { format } from "date-fns";
import { ChevronLeft, Download, Hourglass, KeyRound, ScrollText } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BotAvatar as TeammateAvatar } from "@/components/bot-avatar"; // vocabulary: allow
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isNotFound } from "@/lib/client/errors";
import { chatHref } from "@/lib/utils";
import { useAppState } from "@/features/app-shell";
import { formatCost, runStatusLabel } from "../format";
import { exportRunHref } from "../ranges";
import { useRunModelLogs } from "../hooks";
import { CodexEvents } from "./codex-events";
import { RequestCard } from "./request-card";
import { UnlinkedTools } from "./tool-calls";

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "error" }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd
        className={
          tone === "error"
            ? "text-[16px] font-semibold text-destructive tabular-nums"
            : "text-[16px] font-semibold tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Header({ logs, empty }: { logs: RunModelLogs; empty: boolean }) {
  const { data: state } = useAppState();
  const teammate = state?.bots.find((t) => t.id === logs.run.teammateId); // vocabulary: allow
  const name = logs.run.teammateName ?? "Former teammate";
  const { run, totals } = logs;
  return (
    <header className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 items-start gap-3">
        <TeammateAvatar
          name={name}
          color={teammate?.color ?? "#888888"}
          emoji={teammate?.emoji}
          size="md"
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[22px] leading-tight font-semibold sm:text-[26px]">
            {name}
            <span className="font-normal text-muted-foreground"> in </span>
            <Link
              href={chatHref(run.chatId, run.id)}
              className="underline-offset-4 hover:underline"
              data-testid="inspector-chat-link"
            >
              {run.chatTitle}
            </Link>
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {format(new Date(run.createdAt), "EEE, MMM d, h:mm a")} ·{" "}
            <span className={run.status === "failed" ? "text-destructive" : undefined}>
              {runStatusLabel(run.status)}
            </span>
          </p>
        </div>
      </div>
      {run.prompt && (
        // A preview: its line breaks would only leave the clamp's last line empty.
        <blockquote
          className="line-clamp-3 border-l-2 pl-3 text-[13.5px] text-muted-foreground [overflow-wrap:anywhere]"
          title={run.prompt}
        >
          {run.prompt.replace(/\s+/g, " ").trim()}
        </blockquote>
      )}
      {run.error && (
        <p className="text-[13px] text-destructive [overflow-wrap:anywhere]">{run.error}</p>
      )}
      {!empty && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border bg-card px-4 py-3 sm:grid-cols-4">
          <Stat label="Model requests" value={totals.requests} />
          <Stat
            label="Tokens"
            value={
              <>
                {compactNumber(totals.inputTokens + totals.outputTokens)}
                <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">
                  {compactNumber(totals.cachedInputTokens)} cached
                </span>
              </>
            }
          />
          <Stat
            label="Cost on your API key"
            value={
              <>
                {formatCost(totals.costMicros)}
                {totals.estimated && (
                  <span
                    className="ml-1.5 text-[12px] font-normal text-muted-foreground"
                    data-testid="run-cost-estimated"
                  >
                    includes an estimate
                  </span>
                )}
              </>
            }
          />
          <Stat
            label="Errors"
            value={totals.errors}
            tone={totals.errors > 0 ? "error" : undefined}
          />
        </dl>
      )}
    </header>
  );
}

function TurnSection({
  turn,
  index,
  count,
  offset,
}: {
  turn: ModelLogTurn;
  index: number;
  count: number;
  offset: number;
}) {
  const apiKey = turn.accessMode === "api_key";
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="model-turn">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-semibold">{count > 1 ? `Turn ${index + 1}` : "Turn"}</h2>
        <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
          {apiKey && <KeyRound className="size-3.5" />}
          {apiKey ? "On your API key" : "On your ChatGPT plan"} · started{" "}
          {format(new Date(turn.startedAt), "h:mm:ss a")}
        </span>
      </div>
      {index > 0 && apiKey && (
        <p className="text-[13px] text-muted-foreground">
          The plan reached its limit, so the run went on with your API key in a new thread.
        </p>
      )}
      {turn.requests.length ? (
        <ol className="flex min-w-0 flex-col gap-2">
          {turn.requests.map((request, i) => (
            <RequestCard key={request.id} request={request} index={offset + i + 1} />
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
          No model requests were logged for this turn. The model proxy may have been off.
        </p>
      )}
    </section>
  );
}

function NoLogs({ chatId, runId }: { chatId: string; runId: string }) {
  return (
    <div
      className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6"
      data-testid="no-model-logs"
    >
      <ScrollText className="size-5 text-muted-foreground" />
      <p className="text-[14px] font-medium">No model logs for this run</p>
      <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
        Model logs may have been turned off when it ran, or it ran before they started.
      </p>
      <Link
        href={chatHref(chatId, runId)}
        className="text-[13.5px] font-medium underline-offset-4 hover:underline"
      >
        Back to the chat
      </Link>
    </div>
  );
}

function Logs({ logs }: { logs: RunModelLogs }) {
  const empty = logs.turns.length === 0 && logs.events === 0;
  let offset = 0;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Header logs={logs} empty={empty} />
      {empty ? (
        <NoLogs chatId={logs.run.chatId} runId={logs.run.id} />
      ) : (
        <>
          {logs.bodiesExpiredAt && (
            <div
              className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3"
              data-testid="bodies-expired"
            >
              <Hourglass className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-0.5 text-[13px]">
                <span className="font-medium">
                  Bodies expired on {format(new Date(logs.bodiesExpiredAt), "MMM d, yyyy")}
                </span>
                <span className="text-muted-foreground">
                  What this run sent the model and what came back were removed under your{" "}
                  <Link
                    href="/settings/model-logs/retention"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    retention setting
                  </Link>
                  . Its numbers, statuses and tool names stay.
                </span>
              </div>
            </div>
          )}
          {logs.turns.length === 0 && (
            <p className="rounded-xl border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
              Codex never started a turn for this run, so it made no model requests.
            </p>
          )}
          {logs.shownRequests < logs.totals.requests && (
            <p
              data-testid="requests-cut"
              className="rounded-xl border border-dashed px-4 py-3 text-[13px] text-muted-foreground"
            >
              This run made {logs.totals.requests.toLocaleString("en-US")} model requests. The first{" "}
              {logs.shownRequests.toLocaleString("en-US")} are listed below; the totals above count
              all of them.
            </p>
          )}
          {logs.turns.map((turn, index) => {
            const section = (
              <TurnSection
                key={`${turn.threadId}-${turn.turnId}`}
                turn={turn}
                index={index}
                count={logs.turns.length}
                offset={offset}
              />
            );
            offset += turn.requests.length;
            return section;
          })}
          {logs.unlinkedTools.length > 0 && (
            <section className="flex min-w-0 flex-col gap-2">
              <h2 className="text-[15px] font-semibold">Other tool activity</h2>
              <p className="text-[13px] text-muted-foreground">
                Tool items Codex reported that no logged model call explains.
              </p>
              <div className="rounded-xl border bg-card px-2 py-1.5">
                <UnlinkedTools outcomes={logs.unlinkedTools} />
              </div>
            </section>
          )}
          <CodexEvents runId={logs.run.id} count={logs.events} />
        </>
      )}
    </div>
  );
}

/** Everything the logs hold about one run: its turns, model requests and tool calls. */
export function RunInspector({ runId }: { runId: string }) {
  const logs = useRunModelLogs(runId);
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-4 py-8 sm:px-10 sm:py-12">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/settings/model-logs"
            className="-ml-1 flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Model logs
          </Link>
          {logs.data && logs.data.totals.requests > 0 && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={exportRunHref(runId)}
                download
                title="Every model request of this run, rebuilt in full, one JSON object per line"
                data-testid="export-run"
              >
                <Download />
                Export JSONL
              </a>
            </Button>
          )}
        </div>
        {logs.data ? (
          <Logs logs={logs.data} />
        ) : logs.error ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border px-5 py-5">
            <p className="text-[14px] font-medium">
              {isNotFound(logs.error) ? "This run is gone" : "Couldn't load this run"}
            </p>
            <p className="text-[13.5px] text-muted-foreground">
              {isNotFound(logs.error)
                ? "It was deleted, with its chat or its teammate."
                : logs.error.message}
            </p>
            {!isNotFound(logs.error) && (
              <button
                type="button"
                className="text-[13.5px] font-medium underline-offset-4 hover:underline"
                onClick={() => void logs.refetch()}
              >
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5" data-testid="run-inspector-loading">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-[10px]" />
              <Skeleton className="h-7 w-64 rounded-lg" />
            </div>
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        )}
      </div>
    </div>
  );
}
