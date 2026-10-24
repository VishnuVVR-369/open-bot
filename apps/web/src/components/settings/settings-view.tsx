"use client";

import { EGRESS_OPTIONS, formatDollars, type EgressModeSetting } from "@open-bot/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  BellRing,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  removeApiKey,
  saveApiKey,
  setMonthlyCap,
  setChatgptAuthSource,
  setEgressMode,
  setTimezone,
  signOutChatgpt,
  startChatgptLogin,
} from "@/lib/actions";
import { authClient } from "@/lib/auth-client";
import { getJson } from "@/lib/client/api";
import { queryKeys, useAppState } from "@/lib/client/queries";
import type { ModelAccessView, UsageView } from "@/lib/types";
import { cn, compactNumber } from "@/lib/utils";
import { ConnectionsSection } from "@/components/settings/connections-section";
import { EmailSection } from "@/components/settings/email-section";
import { PushSection } from "@/components/settings/push-section";
import { ProfileEditor } from "./profile-editor";
import { TelegramSection } from "./telegram-section";

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="grid scroll-mt-8 gap-5 border-t pt-8 first:border-t-0 first:pt-0 md:grid-cols-[240px_minmax(0,1fr)]"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {description && <p className="text-[13.5px] text-muted-foreground">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

function Choice({
  checked,
  onSelect,
  title,
  description,
  disabled,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-60",
        checked && "border-foreground/50 bg-muted/40",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked && "border-foreground bg-foreground",
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-background" />}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[14px] font-medium">{title}</span>
        <span className="text-[13px] text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

interface RateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function Meter({ label, window }: { label: string; window: RateWindow }) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[13px]">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {Math.round(used)}% used
          {window.resetsAt &&
            ` · resets ${formatDistanceToNowStrict(new Date(window.resetsAt * 1000), { addSuffix: true })}`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <div
          className={cn(
            "h-full rounded-full",
            used > 85 ? "bg-destructive" : used > 60 ? "bg-manual" : "bg-foreground",
          )}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}

function windowLabel(minutes: number | null, fallback: string) {
  if (!minutes) return fallback;
  if (minutes <= 600) return `${Math.round(minutes / 60)}-hour limit`;
  if (minutes >= 10_000) return "Weekly limit";
  return `${Math.round(minutes / 1440)}-day limit`;
}

function ChatgptSection() {
  const { data: state } = useAppState();
  const codex = state?.codex;
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [login, setLogin] = useState<{ verificationUrl: string; userCode: string } | null>(null);
  const limits = useQuery({
    queryKey: ["rate-limits"],
    queryFn: async () => {
      const result = await getJson<{ rateLimits: unknown }>("/api/rate-limits");
      return result.rateLimits as {
        rateLimits?: { primary: RateWindow | null; secondary: RateWindow | null };
      } | null;
    },
    enabled: Boolean(codex?.account),
    refetchInterval: 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.state });

  useEffect(() => {
    if (codex?.login) setLogin(codex.login);
    if (codex?.account) setLogin(null);
  }, [codex?.login, codex?.account]);

  if (!codex) {
    return (
      <p className="text-[14px] text-muted-foreground">
        The worker isn&apos;t running, so the connection can&apos;t be checked.
      </p>
    );
  }

  const primary = limits.data?.rateLimits?.primary;
  const secondary = limits.data?.rateLimits?.secondary;

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3.5">
        <div className="flex items-center gap-3">
          <span
            className={cn("size-2.5 rounded-full", codex.account ? "bg-done" : "bg-destructive")}
          />
          <div className="flex flex-col">
            <span className="text-[14px] font-medium">
              {codex.account
                ? codex.account.type === "chatgpt"
                  ? `ChatGPT ${codex.account.planType ? codex.account.planType[0]!.toUpperCase() + codex.account.planType.slice(1) : ""}`
                  : "OpenAI API key"
                : "Not connected"}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {codex.account?.email ?? codex.error ?? "Sign in to let your teammates work."}
            </span>
          </div>
        </div>
        {codex.account && codex.authSource === "device" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              startTransition(async () => {
                const result = await signOutChatgpt();
                if (!result.ok) toast.error(result.error);
                await refresh();
              })
            }
          >
            Sign out
          </Button>
        )}
      </div>

      {(primary || secondary) && (
        <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5">
          {primary && (
            <Meter
              label={windowLabel(primary.windowDurationMins, "Short-term limit")}
              window={primary}
            />
          )}
          {secondary && (
            <Meter
              label={windowLabel(secondary.windowDurationMins, "Long-term limit")}
              window={secondary}
            />
          )}
        </div>
      )}

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="How the computer signs in">
        <Choice
          checked={codex.authSource === "host"}
          disabled={pending}
          onSelect={() =>
            startTransition(async () => {
              const result = await setChatgptAuthSource("host");
              if (!result.ok) toast.error(result.error);
              await refresh();
            })
          }
          title="Use this Mac's Codex login"
          description="For local development: the computer borrows the session of the Codex app on this Mac, read-only."
        />
        <Choice
          checked={codex.authSource === "device"}
          disabled={pending}
          onSelect={() =>
            startTransition(async () => {
              const result = await setChatgptAuthSource("device");
              if (!result.ok) toast.error(result.error);
              await refresh();
            })
          }
          title="Sign in on the computer"
          description="The computer keeps its own ChatGPT login. Use this when it runs in the cloud."
        />
      </div>

      {codex.authSource === "device" && !codex.account && (
        <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-4">
          {login ? (
            <>
              <p className="text-[14px]">Open the link, sign in to ChatGPT, and enter this code:</p>
              <div className="flex items-center gap-3">
                <code className="rounded-lg bg-subtle px-3 py-2 font-mono text-[20px] font-semibold tracking-[0.2em]">
                  {login.userCode}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copy code"
                  onClick={() => void navigator.clipboard.writeText(login.userCode)}
                >
                  <Copy />
                </Button>
              </div>
              <Button asChild className="w-fit">
                <a href={login.verificationUrl} target="_blank" rel="noreferrer">
                  Open ChatGPT sign-in <ExternalLink />
                </a>
              </Button>
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Waiting for you to finish signing in…
              </p>
            </>
          ) : (
            <Button
              className="w-fit"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await startChatgptLogin();
                  if (!result.ok) toast.error(result.error);
                  else setLogin(result.data);
                })
              }
            >
              {pending && <Loader2 className="animate-spin" />}
              Sign in with ChatGPT
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function BrowsingSection() {
  const { data: state } = useAppState();
  const egress = state?.computer.egress;
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  return (
    <>
      <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3.5">
        <Laptop className="size-4 text-muted-foreground" />
        <span className="flex-1 text-[14px]">
          {egress?.agentOnline
            ? "The desktop app is connected."
            : "The desktop app isn't connected."}
        </span>
        <span
          className={cn(
            "size-2.5 rounded-full",
            egress?.agentOnline ? "bg-done" : "bg-muted-foreground/40",
          )}
        />
      </div>
      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-label="Where the browser goes online"
      >
        {EGRESS_OPTIONS.map((option) => (
          <Choice
            key={option.value}
            checked={egress?.mode === option.value}
            disabled={pending}
            title={option.label}
            description={option.description}
            onSelect={() =>
              startTransition(async () => {
                const result = await setEgressMode(option.value as EgressModeSetting);
                if (!result.ok) toast.error(result.error);
                await queryClient.invalidateQueries({ queryKey: queryKeys.state });
              })
            }
          />
        ))}
      </div>
    </>
  );
}

function TimezoneSection() {
  const { data: state } = useAppState();
  const queryClient = useQueryClient();
  const zones = useMemo(() => {
    const supported =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? [];
    return supported.includes("UTC") ? supported : ["UTC", ...supported];
  }, []);
  const browserZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const current = state?.timezone ?? "UTC";
  const save = async (zone: string) => {
    const result = await setTimezone(zone);
    if (!result.ok) toast.error(result.error);
    else toast("Timezone saved", { description: zone });
    await queryClient.invalidateQueries({ queryKey: queryKeys.state });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={current} onValueChange={(zone) => void save(zone)}>
        <SelectTrigger className="w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          {zones.map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone.replace(/_/g, " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {browserZone !== current && (
        <Button variant="ghost" size="sm" onClick={() => void save(browserZone)}>
          Use {browserZone.replace(/_/g, " ")}
        </Button>
      )}
    </div>
  );
}

function NotificationsSection() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  useEffect(
    () =>
      setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    [],
  );
  if (permission === "granted") {
    return (
      <p className="flex items-center gap-2 text-[14px]">
        <Check className="size-4 text-done" /> Desktop alerts are on. You get one when a teammate
        finishes or needs you while this tab is in the background.
      </p>
    );
  }
  if (permission === "unsupported")
    return (
      <p className="text-[14px] text-muted-foreground">
        This browser doesn&apos;t support desktop alerts.
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        onClick={async () => setPermission(await Notification.requestPermission())}
      >
        <BellRing />
        Turn on desktop alerts
      </Button>
      {permission === "denied" && (
        <p className="text-[13px] text-muted-foreground">
          Alerts are blocked for this site. Allow them in your browser&apos;s site settings.
        </p>
      )}
    </div>
  );
}

function PasskeySection() {
  const passkeys = authClient.useListPasskeys();
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {passkeys.data && passkeys.data.length > 0 && (
        <ul className="divide-y rounded-xl border bg-card">
          {passkeys.data.map((passkey) => (
            <li key={passkey.id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
              <KeyRound className="size-4 text-muted-foreground" />
              <span className="flex-1">{passkey.name || "Passkey"}</span>
              <span className="text-[12.5px] text-muted-foreground">
                Added {formatDistanceToNowStrict(new Date(passkey.createdAt), { addSuffix: true })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="outline"
        className="w-fit"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const result = await authClient.passkey.addPasskey({
            name: navigator.platform || "This device",
          });
          setPending(false);
          if (result?.error) toast.error(result.error.message ?? "The passkey wasn't added.");
          else {
            toast("Passkey added");
            void passkeys.refetch();
          }
        }}
      >
        {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Add a passkey
      </Button>
    </div>
  );
}

/** A section's data is loading, or failed to load and can be retried. */
function SectionState({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  if (!error) return <Skeleton className="h-24 w-full rounded-xl" />;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3 text-[13.5px]">
      <span className="text-muted-foreground">Couldn&apos;t load this. {error.message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function FallbackSection() {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");
  const [cap, setCap] = useState<string | null>(null);
  const access = useQuery({
    queryKey: ["model-access"],
    queryFn: () => getJson<ModelAccessView>("/api/model-access"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["model-access"] });
  const data = access.data;
  if (!data) return <SectionState error={access.error} onRetry={() => void access.refetch()} />;
  const capDollars = data.capMicros / 1_000_000;
  const used = data.capMicros > 0 ? Math.min(100, (data.spendMicros / data.capMicros) * 100) : 100;

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border px-4 py-3.5",
          data.planLimitedUntil ? "border-manual/40 bg-manual/[0.07]" : "bg-card",
        )}
        data-testid="fallback-status"
      >
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            data.planLimitedUntil ? "bg-manual" : "bg-done",
          )}
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">
            {data.planLimitedUntil
              ? data.keyHint
                ? "Running on your API key"
                : "Paused: your plan's limit is reached"
              : "Running on your ChatGPT plan"}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {data.planLimitedUntil
              ? `Your plan's limit resets ${formatDistanceToNowStrict(new Date(data.planLimitedUntil), { addSuffix: true })}. Then teammates switch back to it on their own.`
              : data.keyHint
                ? "If the plan's limit is reached, teammates continue on your API key until it resets."
                : "Add an API key so teammates keep working when the plan's limit is reached."}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3.5">
        <span className="text-[14px] font-medium">OpenAI API key</span>
        {data.keyHint ? (
          <div className="flex items-center gap-3">
            <code className="rounded bg-subtle px-2 py-1 font-mono text-[13px]">
              {data.keyHint}
            </code>
            <span className="text-[13px] text-muted-foreground">Stored encrypted.</span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await removeApiKey();
                  if (!result.ok) toast.error(result.error);
                  else toast("API key removed");
                  await refresh();
                })
              }
            >
              Remove
            </Button>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await saveApiKey(key);
                if (!result.ok) {
                  toast.error(result.error);
                  return;
                }
                setKey("");
                toast("API key saved");
                await refresh();
              });
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-…"
              aria-label="OpenAI API key"
              className="font-mono"
            />
            <Button type="submit" disabled={pending || !key.trim()}>
              Save key
            </Button>
          </form>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[14px] font-medium">Monthly cap</span>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await setMonthlyCap(Number(cap ?? capDollars));
                if (!result.ok) toast.error(result.error);
                else toast("Cap saved");
                setCap(null);
                await refresh();
              });
            }}
          >
            <span className="text-[14px] text-muted-foreground">$</span>
            <Input
              inputMode="decimal"
              value={cap ?? String(capDollars)}
              onChange={(event) => setCap(event.target.value.replace(/[^0-9.]/g, ""))}
              className="w-24 text-right tabular-nums"
              aria-label="Monthly cap in dollars"
            />
            <Button type="submit" variant="outline" size="sm" disabled={pending || cap === null}>
              Save
            </Button>
          </form>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">Spent on the API this month</span>
            <span className="tabular-nums">
              {formatDollars(data.spendMicros)} of {formatDollars(data.capMicros)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
            <div
              className={cn(
                "h-full rounded-full",
                used >= 100 ? "bg-destructive" : used > 75 ? "bg-manual" : "bg-foreground",
              )}
              style={{ width: `${used}%` }}
            />
          </div>
          <span className="text-[12.5px] text-muted-foreground">
            At list prices: $2 per million input tokens, $0.10 cached, $10 output. At the cap,
            teammates pause until the plan resets.
          </span>
        </div>
      </div>
    </>
  );
}

function UsageSection() {
  const { data: state } = useAppState();
  const usage = useQuery<UsageView[]>({
    queryKey: ["usage"],
    queryFn: () => getJson<UsageView[]>("/api/usage"),
  });
  if (!usage.data) return <SectionState error={usage.error} onRetry={() => void usage.refetch()} />;
  if (!usage.data.length)
    return <p className="text-[14px] text-muted-foreground">No work yet this month.</p>;
  const total = usage.data.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-[13.5px]">
        <thead className="bg-subtle/60 text-left text-[12px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Teammate</th>
            <th className="px-4 py-2 text-right font-medium">Runs</th>
            <th className="px-4 py-2 text-right font-medium">Input</th>
            <th className="px-4 py-2 text-right font-medium">Cached</th>
            <th className="px-4 py-2 text-right font-medium">Output</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {usage.data.map((row) => {
            const bot = state?.bots.find((b) => b.id === row.botId);
            return (
              <tr key={row.botId ?? "none"}>
                <td className="px-4 py-2">{bot?.name ?? "Archived teammate"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.runs}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {compactNumber(row.inputTokens)}
                </td>
                <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                  {compactNumber(row.cachedInputTokens)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {compactNumber(row.outputTokens)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t px-4 py-2 text-[12.5px] text-muted-foreground">
        {compactNumber(total)} tokens this month. API key spend is under When your plan runs out.
      </p>
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={mounted ? (theme ?? "") : ""}
      onValueChange={(value) => value && setTheme(value)}
      className="w-fit"
    >
      <ToggleGroupItem value="light" className="px-4">
        <Sun /> Light
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" className="px-4">
        <Moon /> Dark
      </ToggleGroupItem>
      <ToggleGroupItem value="system" className="px-4">
        <Monitor /> System
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function SettingsView() {
  return (
    <div className="flex flex-col gap-10">
      <Section
        id="about"
        title="About you"
        description="Every teammate reads this, so you don't repeat yourself. They add what they learn too, like your sizes or favorite airline."
      >
        <ProfileEditor />
      </Section>
      <Section
        title="ChatGPT"
        description="Your teammates run on your ChatGPT plan through Codex on the computer."
      >
        <ChatgptSection />
      </Section>
      <Section
        title="When your plan runs out"
        description="Teammates use your ChatGPT plan first. If its limit is reached, they can continue on an OpenAI API key, up to a monthly cap."
      >
        <FallbackSection />
      </Section>
      <Section
        id="browsing"
        title="Browsing"
        description="Websites often block cloud IPs. The desktop app can route the computer's browser through your home connection."
      >
        <BrowsingSection />
      </Section>
      <Section title="Usage" description="Tokens your teammates used this month.">
        <UsageSection />
      </Section>
      <Section
        title="Timezone"
        description="Used for schedules, and so your teammates know what time it is for you."
      >
        <TimezoneSection />
      </Section>
      <Section
        id="email"
        title="Email"
        description="An address for every teammate. Forward them receipts, threads and requests; they answer from their own address."
      >
        <EmailSection />
      </Section>
      <Section
        id="connections"
        title="Connections"
        description="Services your teammates use directly through MCP, like GitHub, Notion or your own API."
      >
        <ConnectionsSection />
      </Section>
      <Section
        id="telegram"
        title="Telegram"
        description="Approve, take over and talk to your teammates from your phone."
      >
        <TelegramSection />
      </Section>
      <Section
        id="notifications"
        title="Notifications"
        description="Know when a teammate finishes or needs you, on this computer and your phone."
      >
        <PushSection fallback={<NotificationsSection />} />
      </Section>
      <Section
        title="Passkeys"
        description="Sign in with Touch ID or your phone instead of a password."
      >
        <PasskeySection />
      </Section>
      <Section title="Appearance">
        <AppearanceSection />
      </Section>
    </div>
  );
}
