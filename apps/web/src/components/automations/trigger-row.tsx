"use client";

import { describeInterval } from "@open-bot/shared";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Webhook,
} from "lucide-react";
import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  checkTriggerNow,
  deleteTrigger,
  rotateWebhook,
  setTriggerEnabled,
  testWebhook,
} from "@/lib/actions";
import { useTriggerRuns } from "@/lib/client/queries";
import type { BotSummary, TriggerView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConfirmDelete, DetailLabel, LAST_RUN_TEXT, RowAction, RunHistory } from "./shared";
import { TriggerDialog } from "./trigger-dialog";
import { copyWebhookUrl, isLocalOrigin, webhookUrl } from "./webhook-url";

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

/** The page, without the scheme, for a compact line. */
function shortUrl(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

const subscribeNever = () => () => {};

/** The webhook's URL, with copy and a fresh-URL button. */
function WebhookAddress({ trigger, botName }: { trigger: TriggerView; botName: string }) {
  // The URL uses the address you opened the app at, which only the browser knows.
  const url = useSyncExternalStore(
    subscribeNever,
    () => webhookUrl(trigger.hookPath!),
    () => trigger.hookPath!,
  );
  const local = useSyncExternalStore(subscribeNever, isLocalOrigin, () => false);
  const [rotating, startRotate] = useTransition();
  return (
    <div className="flex flex-col gap-1.5">
      <DetailLabel>URL</DetailLabel>
      <div className="flex items-center gap-1.5">
        <code
          className="min-w-0 flex-1 truncate rounded-lg border bg-subtle px-2.5 py-1.5 font-mono text-[12.5px]"
          data-testid="webhook-url"
        >
          {url}
        </code>
        <RowAction label="Copy URL" onClick={() => void copyWebhookUrl(trigger.hookPath!)}>
          <Copy />
        </RowAction>
        <RowAction
          label="New URL"
          disabled={rotating}
          onClick={() =>
            startRotate(async () => {
              const result = await rotateWebhook(trigger.id);
              if (!result.ok) toast.error(result.error);
              else
                toast("The webhook has a new URL", { description: "The old one stopped working." });
            })
          }
        >
          <RotateCcw className={cn(rotating && "animate-spin")} />
        </RowAction>
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Anything that knows this URL can start {botName}, so keep it private. It takes GET and POST
        with up to 256 KB of JSON or text, and starts up to 30 runs an hour.
      </p>
      <pre className="overflow-x-auto rounded-lg border bg-subtle px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
        {`curl -X POST ${url} \\\n  -H 'content-type: application/json' -d '{"hello": "world"}'`}
      </pre>
      {local && (
        <p className="text-[12.5px] text-waiting">
          This address only works on this computer. Services on the internet can call it once
          open-bot runs on a public address.
        </p>
      )}
    </div>
  );
}

function TriggerDetails({ trigger, botName }: { trigger: TriggerView; botName: string }) {
  const { data: history, isLoading } = useTriggerRuns(trigger.id, true);
  return (
    <div className="flex flex-col gap-4 border-t px-4 py-4 sm:pl-[68px]">
      {trigger.kind === "watch" && trigger.url && (
        <div className="flex flex-col gap-1">
          <DetailLabel>Page</DetailLabel>
          <a
            href={trigger.url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1.5 text-[13.5px] text-foreground underline-offset-4 hover:underline"
          >
            <span className="truncate">{trigger.url}</span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
          <span className="text-[12.5px] text-muted-foreground">
            {describeInterval(trigger.intervalMinutes ?? 60)}
            {trigger.lookFor
              ? `, fires when “${trigger.lookFor}” appears`
              : ", fires on any change to the text"}
          </span>
        </div>
      )}
      {trigger.kind === "webhook" && trigger.hookPath && (
        <WebhookAddress trigger={trigger} botName={botName} />
      )}
      <div className="flex flex-col gap-1">
        <DetailLabel>What to do</DetailLabel>
        <p className="text-[13.5px] whitespace-pre-wrap">{trigger.prompt}</p>
      </div>
      <RunHistory
        runs={history}
        isLoading={isLoading}
        empty={
          trigger.kind === "watch"
            ? "The page hasn't changed yet."
            : "Nothing has called it yet. Send a test to try it."
        }
      />
    </div>
  );
}

/** What the watch or webhook is doing, in one line. */
function StatusLine({ trigger }: { trigger: TriggerView }) {
  if (trigger.kind === "webhook") {
    return (
      <span className="truncate text-[13px] text-muted-foreground">
        Webhook ·{" "}
        {trigger.lastFiredAt ? `last called ${ago(trigger.lastFiredAt)}` : "not called yet"}
        {!trigger.enabled && " · paused"}
      </span>
    );
  }
  return (
    <span className="truncate text-[13px] text-muted-foreground">
      {shortUrl(trigger.url ?? "")} ·{" "}
      {describeInterval(trigger.intervalMinutes ?? 60).toLowerCase()}
      {trigger.lookFor && ` · waiting for “${trigger.lookFor}”`}
      {!trigger.enabled && " · paused"}
    </span>
  );
}

function CheckLine({ trigger }: { trigger: TriggerView }) {
  if (trigger.lastError)
    return (
      <span className="truncate text-[12.5px] text-destructive" data-testid="watch-error">
        Last check failed: {trigger.lastError}
      </span>
    );
  if (trigger.lastRun)
    return (
      <span className="text-[12.5px] text-muted-foreground">
        {LAST_RUN_TEXT[trigger.lastRun.status] ?? "Last run"}
        {trigger.lastFiredAt && ` ${ago(trigger.lastFiredAt)}`}
      </span>
    );
  if (trigger.kind === "watch")
    return (
      <span className="text-[12.5px] text-muted-foreground">
        {trigger.lastCheckedAt
          ? `No changes yet · checked ${ago(trigger.lastCheckedAt)}`
          : "Checking for the first time…"}
      </span>
    );
  return null;
}

export function TriggerRow({
  trigger,
  bot,
  refresh,
}: {
  trigger: TriggerView;
  bot: BotSummary | undefined;
  refresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, startBusy] = useTransition();
  const KindIcon = trigger.kind === "watch" ? Eye : Webhook;

  return (
    <li
      className={cn("rounded-xl border bg-card", !trigger.enabled && !expanded && "opacity-70")}
      data-testid={trigger.kind === "watch" ? "watch" : "webhook"}
    >
      <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
        {bot && (
          <span className="relative shrink-0">
            <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="md" />
            <span className="absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full bg-card text-foreground/70 shadow-[0_0_0_1px_var(--border)]">
              <KindIcon className="size-3" />
            </span>
          </span>
        )}
        <button
          type="button"
          className="group flex min-w-0 flex-1 basis-[calc(100%-3.5rem)] flex-col gap-0.5 text-left outline-none sm:basis-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid="automation-toggle"
        >
          <span className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-medium group-hover:underline group-focus-visible:underline">
              {trigger.title}
            </span>
            {trigger.createdBy === "bot" && (
              <span className="shrink-0 rounded-full bg-subtle px-2 py-px text-[11px] text-muted-foreground">
                set by {bot?.name ?? "a bot"}
              </span>
            )}
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
          </span>
          <StatusLine trigger={trigger} />
          <CheckLine trigger={trigger} />
        </button>
        <div className="-my-1 ml-auto flex items-center gap-1 sm:my-0">
          {trigger.kind === "watch" ? (
            <RowAction
              label="Check now"
              disabled={busy}
              onClick={() =>
                startBusy(async () => {
                  const result = await checkTriggerNow(trigger.id);
                  if (!result.ok)
                    toast.error("Couldn't check the page", { description: result.error });
                  else if (!result.data.ok)
                    toast.error("Couldn't check the page", { description: result.data.summary });
                  else if (result.data.changed)
                    toast(`“${trigger.title}” changed`, {
                      description: `${result.data.summary}. ${bot?.name ?? "Your teammate"} is on it.`,
                    });
                  else toast(result.data.summary);
                  refresh();
                })
              }
            >
              <RefreshCw className={cn(busy && "animate-spin")} />
            </RowAction>
          ) : (
            <RowAction
              label="Send a test"
              disabled={busy || !trigger.enabled}
              onClick={() =>
                startBusy(async () => {
                  const result = await testWebhook(trigger.id);
                  if (!result.ok)
                    toast.error("Couldn't call the webhook", { description: result.error });
                  else
                    toast("Sent a test request", {
                      description: `${bot?.name ?? "Your teammate"} is on it.`,
                    });
                  refresh();
                })
              }
            >
              <Send />
            </RowAction>
          )}
          <Tooltip>
            <TriggerDialog
              kind={trigger.kind}
              existing={trigger}
              trigger={
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Edit">
                    <Pencil />
                  </Button>
                </TooltipTrigger>
              }
            />
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <ConfirmDelete
            title={`Delete “${trigger.title}”?`}
            description={
              trigger.kind === "watch"
                ? "The page won't be checked again. Past runs stay in the Scheduled chat."
                : "Its URL stops working. Past runs stay in the Scheduled chat."
            }
            onConfirm={async () => {
              const result = await deleteTrigger(trigger.id);
              if (!result.ok) toast.error(result.error);
              refresh();
            }}
          />
          <Switch
            className="ml-2"
            checked={trigger.enabled}
            aria-label={trigger.enabled ? "Pause" : "Resume"}
            onCheckedChange={async (checked) => {
              const result = await setTriggerEnabled(trigger.id, checked);
              if (!result.ok) toast.error(result.error);
              refresh();
            }}
          />
        </div>
      </div>
      {expanded && <TriggerDetails trigger={trigger} botName={bot?.name ?? "your teammate"} />}
    </li>
  );
}
