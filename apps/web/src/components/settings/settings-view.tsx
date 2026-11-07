"use client";

import {
  EGRESS_OPTIONS,
  formatDollars,
  relativeTime,
  type EgressModeSetting,
} from "@open-bot/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Bell,
  BellRing,
  Brain,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  Moon,
  Plug,
  ShieldCheck,
  Sun,
  SunMoon,
  Trash2,
  UserRound,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { passkeyLabel } from "@/lib/passkey-name";
import { getJson } from "@/lib/client/api";
import { queryKeys, useAppState } from "@/lib/client/queries";
import { isComputerOnline } from "@/lib/status";
import type { ModelAccessView, UsageView } from "@/lib/types";
import { cn, compactNumber } from "@/lib/utils";
import { ConnectionsSection } from "@/components/settings/connections-section";
import { EmailSection } from "@/components/settings/email-section";
import { PushSection } from "@/components/settings/push-section";
import { ProfileEditor } from "./profile-editor";
import { PasswordSection } from "./password-section";
import { OfflineNote, SectionState } from "./section-state";
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
      className="flex scroll-mt-8 flex-col gap-4 border-t pt-8 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {description && (
          <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">{description}</p>
        )}
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
        checked && "border-foreground/60 bg-muted/40",
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
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
        <div
          className={cn(
            "h-full rounded-full",
            used >= 100 ? "bg-destructive" : used > 80 ? "bg-attention" : "bg-foreground/45",
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
      <OfflineNote>
        Your ChatGPT connection shows here once it&apos;s back. This updates by itself.
      </OfflineNote>
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
              {codex.stale && codex.account ? " · Cached while computer is idle" : ""}
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

/** For a value that never changes while the page is open. */
const noSubscription = () => () => {};

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
  // The device's zone is only known in the browser; the server renders without the suggestion,
  // so both sides agree until hydration ends.
  const browserZone = useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
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
      {browserZone && browserZone !== current && (
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

type Passkey = NonNullable<ReturnType<typeof authClient.useListPasskeys>["data"]>[number];

function PasskeyRow({ passkey, onRemoved }: { passkey: Passkey; onRemoved: () => void }) {
  const label = passkeyLabel(passkey.name);
  return (
    <li className="flex min-h-14 items-center gap-3 py-2 pr-2 pl-4 text-[14px]">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <time
        dateTime={new Date(passkey.createdAt).toISOString()}
        title={new Date(passkey.createdAt).toLocaleString()}
        className="shrink-0 text-[12.5px] text-muted-foreground"
      >
        Added {relativeTime(passkey.createdAt)}
      </time>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              {label} can't sign you in anymore. Remove it from the device too, in its password
              settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const result = await authClient.passkey.deletePasskey({ id: passkey.id });
                if (result?.error)
                  toast.error(result.error.message ?? "The passkey wasn't removed.");
                else toast("Passkey removed");
                onRemoved();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function PasskeySection() {
  const passkeys = authClient.useListPasskeys();
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {passkeys.data && passkeys.data.length === 0 && (
        <p
          className="flex items-center gap-3 rounded-xl border px-4 py-3 text-[14px] text-muted-foreground"
          data-testid="no-passkeys"
        >
          <KeyRound className="size-4" />
          No passkeys yet
        </p>
      )}
      {passkeys.data && passkeys.data.length > 0 && (
        <ul className="divide-y divide-border/70 rounded-xl border bg-card" data-testid="passkeys">
          {passkeys.data.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              onRemoved={() => void passkeys.refetch()}
            />
          ))}
        </ul>
      )}
      <Button
        variant="outline"
        className="w-fit"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          // The server names it after where it's kept, or this browser.
          const result = await authClient.passkey.addPasskey();
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
function FallbackSection() {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");
  const [cap, setCap] = useState<string | null>(null);
  const access = useQuery({
    queryKey: ["model-access"],
    queryFn: () => getJson<ModelAccessView>("/api/model-access"),
  });
  const { data: state } = useAppState();
  // Nothing runs while the computer is offline, so the plan is what teammates use, not what
  // they're running on.
  const offline = Boolean(state && !isComputerOnline(state));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["model-access"] });
  const data = access.data;
  if (!data) return <SectionState error={access.error} onRetry={() => void access.refetch()} />;
  const capDollars = data.capMicros / 1_000_000;
  const capChanged = cap !== null && cap !== "" && Number(cap) !== capDollars;
  const used = data.capMicros > 0 ? Math.min(100, (data.spendMicros / data.capMicros) * 100) : 100;

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl px-4 py-3.5",
          data.planLimitedUntil && !offline
            ? "border border-attention/40 bg-attention/[0.07]"
            : "border bg-card",
        )}
        data-testid="fallback-status"
      >
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            offline ? "bg-idle" : data.planLimitedUntil ? "bg-attention" : "bg-done",
          )}
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">
            {offline
              ? data.planLimitedUntil && data.keyHint
                ? "Set to use your API key"
                : "Set to use your ChatGPT plan"
              : data.planLimitedUntil
                ? data.keyHint
                  ? "Running on your API key"
                  : "Stopped: your plan's limit is reached"
                : "Running on your ChatGPT plan"}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {offline
              ? data.keyHint
                ? "Nothing runs while the computer is offline. Once it's back, teammates use your plan, then your API key if the plan's limit is reached."
                : "Nothing runs while the computer is offline. Once it's back, teammates use your plan."
              : data.planLimitedUntil
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
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={pending}>
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove your API key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    When your plan's limit is reached, teammates stop until it resets instead of
                    continuing on the key. You can add a key again any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() =>
                      startTransition(async () => {
                        const result = await removeApiKey();
                        if (!result.ok) toast.error(result.error);
                        else toast("API key removed");
                        await refresh();
                      })
                    }
                  >
                    Remove key
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
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
            <span className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[14px] text-muted-foreground"
              >
                $
              </span>
              <Input
                inputMode="decimal"
                value={cap ?? String(capDollars)}
                onChange={(event) => setCap(event.target.value.replace(/[^0-9.]/g, ""))}
                className="w-28 pl-6 tabular-nums"
                aria-label="Monthly cap in dollars"
              />
            </span>
            <Button
              type="submit"
              variant={capChanged ? "default" : "outline"}
              size="sm"
              disabled={pending || !capChanged}
            >
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
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
            <div
              className={cn(
                "h-full rounded-full",
                used >= 100 ? "bg-destructive" : used > 80 ? "bg-attention" : "bg-foreground/45",
              )}
              style={{ width: `${used}%` }}
            />
          </div>
          <span className="text-[12.5px] text-muted-foreground">
            At list prices: $2 per million input tokens, $0.10 cached, $10 output. At the cap,
            teammates stop until the plan resets.
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

/** Who's signed in: the owner's mark, name and email, at the top of Account. */
function ProfileBlock() {
  const { data: state } = useAppState();
  if (!state) return <Skeleton className="h-[72px] w-full rounded-xl" />;
  const { name, email } = state.user;
  return (
    <section
      aria-label="Your account"
      className="flex items-center gap-4 rounded-xl border bg-card px-4 py-4"
      data-testid="profile-block"
    >
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-foreground/85 to-foreground text-[17px] font-semibold text-background"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-medium">{name}</span>
        <span className="truncate text-[13.5px] text-muted-foreground">{email}</span>
      </span>
      <a
        href="#security"
        className="flex shrink-0 items-center gap-0.5 rounded-md text-[13px] font-medium text-foreground/80 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12"
      >
        Password and passkeys
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </a>
    </section>
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

type GroupId = "account" | "memory" | "appearance" | "notifications" | "connections" | "security";

/** Settings in groups, one group at a time. Old links to a section (#email) open its group. */
const GROUPS: { id: GroupId; label: string; icon: typeof UserRound; sections: string[] }[] = [
  {
    id: "account",
    label: "Account",
    icon: UserRound,
    sections: ["chatgpt", "plan", "usage", "timezone"],
  },
  { id: "memory", label: "Memory", icon: Brain, sections: ["about"] },
  { id: "appearance", label: "Appearance", icon: SunMoon, sections: [] },
  { id: "notifications", label: "Notifications", icon: Bell, sections: ["telegram"] },
  { id: "connections", label: "Connections", icon: Plug, sections: ["email", "browsing"] },
  {
    id: "security",
    label: "Security",
    icon: ShieldCheck,
    sections: ["password", "set-password", "passkeys"],
  },
];

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function useHash() {
  return useSyncExternalStore(
    subscribeHash,
    () => decodeURIComponent(window.location.hash.slice(1)),
    () => "",
  );
}

function groupFor(hash: string): GroupId {
  return (
    GROUPS.find((group) => group.id === hash || group.sections.includes(hash))?.id ?? "account"
  );
}

function SettingsNav({ current }: { current: GroupId }) {
  return (
    <nav aria-label="Settings" className="md:sticky md:top-0 md:self-start">
      <ul className="-mx-5 flex gap-1 overflow-x-auto px-5 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-0.5 md:px-0">
        {GROUPS.map((group) => {
          const Icon = group.icon;
          const active = group.id === current;
          return (
            <li key={group.id} className="shrink-0">
              <a
                href={`#${group.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-lg px-3 text-[14px] whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12",
                  // A quiet gray fill marks where you are; on the white page a raised white
                  // surface didn't show.
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-subtle hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {group.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function GroupContent({ group, hash }: { group: GroupId; hash: string }) {
  switch (group) {
    case "account":
      return (
        <>
          <ProfileBlock />
          <Section
            id="chatgpt"
            title="ChatGPT"
            description="Your teammates run on your ChatGPT plan through Codex on the computer."
          >
            <ChatgptSection />
          </Section>
          <Section
            id="plan"
            title="When your plan runs out"
            description="Teammates use your ChatGPT plan first. If its limit is reached, they can continue on an OpenAI API key, up to a monthly cap."
          >
            <FallbackSection />
          </Section>
          <Section id="usage" title="Usage" description="Tokens your teammates used this month.">
            <UsageSection />
          </Section>
          <Section
            id="timezone"
            title="Timezone"
            description="Used for schedules, and so your teammates know what time it is for you."
          >
            <TimezoneSection />
          </Section>
        </>
      );
    case "memory":
      return (
        <Section
          id="about"
          title="About you"
          description="Facts and preferences every teammate can use, with where each came from. Suggestions become memory when you confirm them."
        >
          <ProfileEditor />
        </Section>
      );
    case "appearance":
      return (
        <Section
          id="appearance"
          title="Appearance"
          description="How open-bot looks on this device."
        >
          <AppearanceSection />
        </Section>
      );
    case "notifications":
      return (
        <>
          <Section
            id="notifications"
            title="Notifications"
            description="Know when a teammate finishes or needs you, on this computer and your phone."
          >
            <PushSection fallback={<NotificationsSection />} />
          </Section>
          <Section
            id="telegram"
            title="Telegram"
            description="Approve, take over and talk to your teammates from your phone."
          >
            <TelegramSection />
          </Section>
        </>
      );
    case "connections":
      return (
        <>
          <Section
            id="connections"
            title="Connections"
            description="Your Gmail, Calendar and Notion, and other services your teammates use through MCP, like GitHub or your own API."
          >
            <ConnectionsSection />
          </Section>
          <Section
            id="email"
            title="Email"
            description="An address for every teammate. Forward them receipts, threads and requests; they answer from their own address."
          >
            <EmailSection />
          </Section>
          <Section
            id="browsing"
            title="Browsing"
            description="Websites often block cloud IPs. The desktop app can route the computer's browser through your home connection."
          >
            <BrowsingSection />
          </Section>
        </>
      );
    case "security":
      return (
        <>
          <Section id="password" title="Password" description="The password you sign in with.">
            <PasswordSection startWithReset={hash === "set-password"} />
          </Section>
          <Section
            id="passkeys"
            title="Passkeys"
            description="Sign in with Touch ID or your phone instead of a password. A passkey also gets you in if you forget your password."
          >
            <PasskeySection />
          </Section>
        </>
      );
  }
}

export function SettingsView() {
  const hash = useHash();
  const group = groupFor(hash);
  // A link to one section (#email) opens its group, then shows that section.
  useEffect(() => {
    if (!hash || hash === group) return;
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [hash, group]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[176px_minmax(0,1fr)] md:gap-12">
      <SettingsNav current={group} />
      <div
        key={group}
        className={cn("flex min-w-0 flex-col gap-10", group === "security" && "max-w-[600px]")}
        data-testid={`settings-${group}`}
      >
        <GroupContent group={group} hash={hash} />
      </div>
    </div>
  );
}
