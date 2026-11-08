"use client";

import {
  CALENDAR_EVENT_FILTERS,
  CALENDAR_LEADS,
  describeInterval,
  describeLead,
  invalidGmailQuery,
  invalidWatchUrl,
  isAccountTrigger,
  isCalendarEventFilter,
  MAX_GMAIL_QUERY_CHARS,
  TRIGGER_CONNECTION_KIND,
  WATCH_INTERVALS,
  type TriggerKind,
} from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTrigger, updateTrigger } from "@/lib/actions";
import { queryKeys, useAppState, useConnections } from "@/lib/client/queries";
import type { ConnectionView, TriggerView } from "@/lib/types";
import { copyWebhookUrl } from "./webhook-url";

const COPY = {
  watch: {
    newTitle: "New page watch",
    editTitle: "Edit page watch",
    description:
      "The page is checked on a schedule. When it changes, the teammate gets what changed and your instructions, in their Scheduled chat.",
    titlePlaceholder: "Kettle price",
    promptPlaceholder: "Tell me the new price, and whether it's under £30.",
    create: "Start watching",
  },
  webhook: {
    newTitle: "New webhook",
    editTitle: "Edit webhook",
    description:
      "You get a private URL. Whenever a service calls it, the teammate gets the request and your instructions, in their Scheduled chat.",
    titlePlaceholder: "New GitHub issues",
    promptPlaceholder: "Summarize the new issue and tell me if it looks urgent.",
    create: "Create webhook",
  },
  gmail: {
    newTitle: "New Gmail trigger",
    editTitle: "Edit Gmail trigger",
    description:
      "New mail is looked for every 2 minutes. When some arrives, the teammate gets it and your instructions, in their Scheduled chat.",
    titlePlaceholder: "Invoices",
    promptPlaceholder:
      "Add the amount and due date to my bills list, and tell me if it's over £200.",
    create: "Start watching",
  },
  calendar: {
    newTitle: "New Calendar trigger",
    editTitle: "Edit Calendar trigger",
    description:
      "Before each event on your calendar, the teammate gets its details and your instructions, in their Scheduled chat.",
    titlePlaceholder: "Meeting prep",
    promptPlaceholder: "Look up the people I'm meeting and send me a short brief.",
    create: "Start watching",
  },
} as const satisfies Record<TriggerKind, Record<string, string>>;

const NOUN = {
  watch: "watch",
  webhook: "webhook",
  gmail: "trigger",
  calendar: "trigger",
} as const satisfies Record<TriggerKind, string>;

const CONNECTION_LABEL = { gmail: "Gmail", calendar: "Google Calendar" } as const;

/** The connections a trigger of this kind can watch for the teammate: on, signed in, and theirs. */
function watchable(
  connections: ConnectionView[] | undefined,
  kind: "gmail" | "calendar",
  botId: string,
): ConnectionView[] {
  return (connections ?? []).filter(
    (connection) =>
      connection.kind === TRIGGER_CONNECTION_KIND[kind] &&
      connection.account !== null &&
      connection.enabled &&
      (connection.botIds === null || connection.botIds.includes(botId)),
  );
}

/**
 * Create a page watch, a webhook, or a Gmail or Calendar trigger, or edit one when `existing` is
 * given. Opens from `trigger`, or
 * from outside with `open` and `onOpenChange`.
 */
export function TriggerDialog({
  kind,
  botId,
  existing,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  kind: TriggerKind;
  botId?: string;
  existing?: TriggerView;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [selectedBot, setSelectedBot] = useState(botId ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [lookFor, setLookFor] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [query, setQuery] = useState("");
  const [leadMinutes, setLeadMinutes] = useState("30");
  const [events, setEvents] = useState("all");
  const { data: connections, isLoading: loadingConnections } = useConnections();
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const copy = COPY[kind];

  // Start from the automation (or a blank one) each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSelectedBot(existing?.botId ?? botId ?? "");
    setTitle(existing?.title ?? "");
    setPrompt(existing?.prompt ?? "");
    setUrl(existing?.url ?? "");
    setIntervalMinutes(String(existing?.intervalMinutes ?? 60));
    setLookFor(existing?.lookFor ?? "");
    setUrlTouched(false);
    setConnectionId(existing?.connectionId ?? "");
    setQuery(existing?.kind === "gmail" ? (existing.query ?? "") : "");
    setLeadMinutes(String(existing?.leadMinutes ?? 30));
    setEvents(
      existing?.kind === "calendar" && isCalendarEventFilter(existing.query)
        ? existing.query
        : "all",
    );
  }, [open, existing, botId]);

  const botValue = selectedBot || bots[0]?.id || "";
  const urlProblem = kind === "watch" ? invalidWatchUrl(url) : null;
  const queryProblem = kind === "gmail" ? invalidGmailQuery(query) : null;
  const account = isAccountTrigger(kind) ? kind : null;
  const choices = account ? watchable(connections, account, botValue) : [];
  // Keep the one it watches in the menu, even when it's off or no longer the teammate's.
  if (account && existing?.connectionId && !choices.some((c) => c.id === existing.connectionId)) {
    const current = connections?.find((connection) => connection.id === existing.connectionId);
    if (current) choices.push(current);
  }
  const connectionValue = choices.some((c) => c.id === connectionId)
    ? connectionId
    : (choices[0]?.id ?? "");
  const noAccount = account !== null && !loadingConnections && choices.length === 0;
  const leads: { minutes: number; label: string }[] = [...CALENDAR_LEADS];
  if (!leads.some((option) => String(option.minutes) === leadMinutes))
    leads.push({ minutes: Number(leadMinutes), label: describeLead(Number(leadMinutes)) });
  const intervals: { minutes: number; label: string }[] = [...WATCH_INTERVALS];
  // A bot may have picked an interval the menu doesn't offer.
  if (!intervals.some((option) => String(option.minutes) === intervalMinutes))
    intervals.push({
      minutes: Number(intervalMinutes),
      label: describeInterval(Number(intervalMinutes)),
    });

  function submit() {
    if (urlProblem) {
      setUrlTouched(true);
      return;
    }
    if (queryProblem) return;
    startTransition(async () => {
      const input = {
        botId: botValue,
        kind,
        title: title.trim(),
        prompt: prompt.trim(),
        url: kind === "watch" ? url.trim() : null,
        intervalMinutes: kind === "watch" ? Number(intervalMinutes) : null,
        lookFor: kind === "watch" ? lookFor.trim() || null : null,
        connectionId: account ? connectionValue : null,
        query: kind === "gmail" ? query.trim() || null : kind === "calendar" ? events : null,
        leadMinutes: kind === "calendar" ? Number(leadMinutes) : null,
      };
      const result = existing
        ? await updateTrigger(existing.id, input)
        : await createTrigger(input);
      if (!result.ok) {
        toast.error(existing ? "Couldn't save that" : `Couldn't create the ${NOUN[kind]}`, {
          description: result.error,
        });
        return;
      }
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.triggers });
      if (existing) toast("Saved");
      else if (kind === "watch")
        toast("Watching the page", {
          description:
            "The first check learns what it looks like. Changes after that wake your teammate.",
        });
      else if (kind === "gmail")
        toast("Watching for new mail", {
          description: "Mail that arrives from now on wakes your teammate.",
        });
      else if (kind === "calendar")
        toast("Watching your calendar", {
          description: `${describeLead(Number(leadMinutes))} each event, your teammate gets to work.`,
        });
      else if ("hookPath" in result.data && typeof result.data.hookPath === "string") {
        const hookPath = result.data.hookPath;
        toast("Webhook created", {
          description: "Give its URL to the service that should call it.",
          action: { label: "Copy URL", onClick: () => void copyWebhookUrl(hookPath) },
        });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? copy.editTitle : copy.newTitle}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form
          id="trigger-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {(!botId || existing) && (
            <div className="flex flex-col gap-2">
              <Label>Teammate</Label>
              <Select value={botValue} onValueChange={setSelectedBot}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a teammate" />
                </SelectTrigger>
                <SelectContent>
                  {bots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="trigger-title">Name</Label>
            <Input
              id="trigger-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={copy.titlePlaceholder}
              maxLength={80}
            />
          </div>
          {account && (
            <div className="flex flex-col gap-2">
              <Label>Account</Label>
              {noAccount ? (
                <p
                  className="rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground"
                  data-testid="trigger-no-account"
                >
                  This teammate can&apos;t use {CONNECTION_LABEL[account]} yet.{" "}
                  <Link
                    href="/settings#connections"
                    className="text-foreground underline underline-offset-4"
                    onClick={() => setOpen(false)}
                  >
                    Connect it in Settings
                  </Link>
                  , then come back.
                </p>
              ) : (
                <Select
                  value={connectionValue}
                  onValueChange={setConnectionId}
                  disabled={loadingConnections}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={`${CONNECTION_LABEL[account]} account`}
                  >
                    <SelectValue placeholder="Loading…" />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.account?.display ?? connection.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          {kind === "gmail" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="trigger-query">Only mail matching (optional)</Label>
              <Input
                id="trigger-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="from:billing@example.com has:attachment"
                maxLength={MAX_GMAIL_QUERY_CHARS}
                aria-invalid={Boolean(queryProblem)}
              />
              {queryProblem ? (
                <p className="text-[12.5px] text-destructive">{queryProblem}</p>
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  A Gmail search, as you&apos;d type it in Gmail. Leave it empty for all new mail.
                  Mail you send, drafts and spam never count.
                </p>
              )}
            </div>
          )}
          {kind === "calendar" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label>When</Label>
                <Select value={leadMinutes} onValueChange={setLeadMinutes}>
                  <SelectTrigger className="w-full" aria-label="How long before each event">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {leads.map((option) => (
                      <SelectItem key={option.minutes} value={String(option.minutes)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label>Events</Label>
                <Select value={events} onValueChange={setEvents}>
                  <SelectTrigger className="w-full" aria-label="Which events">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CALENDAR_EVENT_FILTERS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {kind === "watch" && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="trigger-url">Page</Label>
                <Input
                  id="trigger-url"
                  type="url"
                  inputMode="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setUrlTouched(true)}
                  placeholder="https://shop.example.com/blue-kettle"
                  aria-invalid={urlTouched && Boolean(urlProblem)}
                />
                {urlTouched && urlProblem ? (
                  <p className="text-[12.5px] text-destructive">{urlProblem}</p>
                ) : (
                  <p className="text-[12.5px] text-muted-foreground">
                    Checked like a signed-out visitor would see it, without a browser.
                  </p>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
                <div className="flex flex-col gap-2">
                  <Label>Check</Label>
                  <Select value={intervalMinutes} onValueChange={setIntervalMinutes}>
                    <SelectTrigger className="w-full" aria-label="How often to check">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {intervals.map((option) => (
                        <SelectItem key={option.minutes} value={String(option.minutes)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="trigger-look-for">Only when this appears (optional)</Label>
                  <Input
                    id="trigger-look-for"
                    value={lookFor}
                    onChange={(e) => setLookFor(e.target.value)}
                    placeholder="In stock"
                    maxLength={200}
                  />
                </div>
              </div>
            </>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="trigger-prompt">What to do</Label>
            <Textarea
              id="trigger-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={copy.promptPlaceholder}
              className="min-h-24"
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="trigger-form"
            disabled={
              pending ||
              !title.trim() ||
              !prompt.trim() ||
              !botValue ||
              (kind === "watch" && !url.trim()) ||
              Boolean(queryProblem) ||
              (account !== null && !connectionValue)
            }
          >
            {pending && <Loader2 className="animate-spin" />}
            {existing ? "Save changes" : copy.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
