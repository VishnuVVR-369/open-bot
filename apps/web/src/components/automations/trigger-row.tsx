"use client";

import {
  describeGmailQuery,
  describeInterval,
  describeLead,
  isAccountTrigger,
  relativeTime,
  type TriggerKind,
} from "@open-bot/domain";
import {
  CalendarDays,
  Copy,
  ExternalLink,
  Eye,
  Mail,
  RefreshCw,
  RotateCcw,
  Send,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Switch } from "@/components/ui/switch";
import { attempt } from "@/lib/client/mutate";
import { useTriggerRuns } from "@/lib/client/queries";
import { api } from "@/lib/client/rpc";
import type { BotSummary, TriggerView } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DetailLabel,
  LAST_RUN_TEXT,
  OFFLINE_ACTION,
  RowAction,
  RowMenu,
  RunHistory,
  StateBadge,
  useCanRun,
} from "./shared";
import { TriggerDialog } from "./trigger-dialog";
import { copyWebhookUrl, isLocalOrigin, webhookUrl } from "./webhook-url";

const ago = (iso: string) => relativeTime(iso);

/** The page, without the scheme, for a compact line. */
function shortUrl(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

const KIND_ICONS: Record<TriggerKind, LucideIcon> = {
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
};

/** Which mail, or which events, an account trigger wakes for, in a few words. */
function accountWatch(trigger: TriggerView): string {
  if (trigger.kind === "gmail") return describeGmailQuery(trigger.query);
  const events = trigger.query === "guests" ? "event with other people" : "event";
  return `${describeLead(trigger.leadMinutes ?? 30).toLowerCase()} each ${events}`;
}

const EMPTY_HISTORY: Record<TriggerKind, string> = {
  watch: "The page hasn't changed yet.",
  webhook: "Nothing has called it yet. Send a test to try it.",
  gmail: "No new mail has woken it yet.",
  calendar: "No events have come up yet.",
};

const DELETE_TEXT: Record<TriggerKind, string> = {
  watch: "The page won't be checked again. Past runs stay in the Scheduled chat.",
  webhook: "Its URL stops working. Past runs stay in the Scheduled chat.",
  gmail: "New mail won't wake your teammate any more. Past runs stay in the Scheduled chat.",
  calendar: "Events won't wake your teammate any more. Past runs stay in the Scheduled chat.",
};

const CHECK_FAILED: Record<TriggerKind, string> = {
  watch: "Couldn't check the page",
  webhook: "Couldn't call the webhook",
  gmail: "Couldn't check for new mail",
  calendar: "Couldn't check the calendar",
};

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
              const result = await attempt(api.triggers.rotateToken({ triggerId: trigger.id }));
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
        <p className="text-[12.5px] text-attention-ink">
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
      {isAccountTrigger(trigger.kind) && (
        <div className="flex flex-col gap-1">
          <DetailLabel>{trigger.kind === "gmail" ? "Mail" : "Events"}</DetailLabel>
          <span className="text-[13.5px]">{trigger.account ?? "An account that was removed"}</span>
          <span className="text-[12.5px] text-muted-foreground">
            {trigger.kind === "gmail"
              ? `Wakes ${botName} for ${describeGmailQuery(trigger.query)}, checked every 2 minutes`
              : `Wakes ${botName} ${accountWatch(trigger)}, skipping all-day events and ones you declined`}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <DetailLabel>What to do</DetailLabel>
        <p className="text-[13.5px] whitespace-pre-wrap">{trigger.prompt}</p>
      </div>
      <RunHistory runs={history} isLoading={isLoading} empty={EMPTY_HISTORY[trigger.kind]} />
    </div>
  );
}

/** What the trigger is doing, in one line. */
function StatusLine({ trigger }: { trigger: TriggerView }) {
  if (isAccountTrigger(trigger.kind)) {
    return (
      <span className="line-clamp-2 text-[13px] text-muted-foreground sm:truncate">
        {trigger.account ?? "No account"} · {accountWatch(trigger)}
      </span>
    );
  }
  if (trigger.kind === "webhook") {
    return (
      <span className="truncate text-[13px] text-muted-foreground">
        Webhook ·{" "}
        {trigger.lastFiredAt ? `last called ${ago(trigger.lastFiredAt)}` : "not called yet"}
      </span>
    );
  }
  return (
    <span className="truncate text-[13px] text-muted-foreground">
      {shortUrl(trigger.url ?? "")} ·{" "}
      {describeInterval(trigger.intervalMinutes ?? 60).toLowerCase()}
      {trigger.lookFor && ` · waiting for “${trigger.lookFor}”`}
    </span>
  );
}

function CheckLine({ trigger }: { trigger: TriggerView }) {
  if (trigger.lastError)
    return (
      <span
        className="line-clamp-2 text-[12.5px] text-destructive sm:truncate"
        data-testid="watch-error"
      >
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
  if (isAccountTrigger(trigger.kind))
    return (
      <span className="text-[12.5px] text-muted-foreground">
        {trigger.lastCheckedAt
          ? `${trigger.kind === "gmail" ? "No new mail yet" : "Nothing coming up yet"} · checked ${ago(trigger.lastCheckedAt)}`
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
  const [editing, setEditing] = useState(false);
  const [busy, startBusy] = useTransition();
  const canRun = useCanRun();
  const KindIcon = KIND_ICONS[trigger.kind];

  return (
    <li data-testid={trigger.kind}>
      <div className="flex flex-wrap items-start gap-4 px-4 py-3.5 sm:items-center">
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
            {!trigger.enabled && <StateBadge>Off</StateBadge>}
            {trigger.createdBy === "bot" && (
              <span className="shrink-0 text-[12px] text-muted-foreground">
                Set by {bot?.name ?? "a teammate"}
              </span>
            )}
          </span>
          <StatusLine trigger={trigger} />
          <CheckLine trigger={trigger} />
        </button>
        <div className="-my-1 ml-auto flex items-center gap-1 sm:my-0">
          {trigger.kind !== "webhook" ? (
            <RowAction
              label="Check now"
              labeled
              disabled={busy}
              unavailable={canRun ? undefined : OFFLINE_ACTION}
              onClick={() =>
                startBusy(async () => {
                  const result = await attempt(api.triggers.check({ triggerId: trigger.id }));
                  const failed = CHECK_FAILED[trigger.kind];
                  if (!result.ok) toast.error(failed, { description: result.error });
                  else if (!result.data.ok)
                    toast.error(failed, { description: result.data.summary });
                  else if (result.data.changed)
                    toast(trigger.kind === "watch" ? `“${trigger.title}” changed` : trigger.title, {
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
              labeled
              disabled={busy || !trigger.enabled}
              unavailable={canRun ? undefined : OFFLINE_ACTION}
              onClick={() =>
                startBusy(async () => {
                  const result = await attempt(api.triggers.test({ triggerId: trigger.id }));
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
          <Switch
            className="mx-1.5"
            checked={trigger.enabled}
            aria-label="On"
            onCheckedChange={async (checked) => {
              const result = await attempt(
                api.triggers.setEnabled({ triggerId: trigger.id, enabled: checked }),
              );
              if (!result.ok) toast.error(result.error);
              refresh();
            }}
          />
          <RowMenu
            title={trigger.title}
            deleteDescription={DELETE_TEXT[trigger.kind]}
            onEdit={() => setEditing(true)}
            onDelete={async () => {
              const result = await attempt(api.triggers.remove({ triggerId: trigger.id }));
              if (!result.ok) toast.error(result.error);
              refresh();
            }}
          />
          <TriggerDialog
            kind={trigger.kind}
            existing={trigger}
            open={editing}
            onOpenChange={setEditing}
          />
        </div>
      </div>
      {expanded && <TriggerDetails trigger={trigger} botName={bot?.name ?? "your teammate"} />}
    </li>
  );
}
