"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/client/mutate";
import { useAppState } from "@/lib/client/queries";
import { api, orpc } from "@/lib/client/rpc";
import type { RateLimitWindowView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { OfflineNote } from "./section-state";
import { Choice } from "./choice";

function Meter({ label, window }: { label: string; window: RateLimitWindowView }) {
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

export function ChatgptSection() {
  const { data: state } = useAppState();
  const codex = state?.codex;
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [login, setLogin] = useState<{ verificationUrl: string; userCode: string } | null>(null);
  const limits = useQuery(
    orpc.settings.rateLimits.queryOptions({
      enabled: Boolean(codex?.account),
      refetchInterval: 60_000,
    }),
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });

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

  const primary = limits.data?.rateLimits.primary;
  const secondary = limits.data?.rateLimits.secondary;

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
                const result = await attempt(api.chatgpt.signOut());
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
              const result = await attempt(api.chatgpt.setAuthSource({ source: "host" }));
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
              const result = await attempt(api.chatgpt.setAuthSource({ source: "device" }));
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
                  const result = await attempt(api.chatgpt.startLogin());
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
