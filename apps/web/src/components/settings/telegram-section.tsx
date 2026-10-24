"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, Send } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  connectTelegram,
  disconnectTelegram,
  sendTelegramTest,
  telegramLinkCode,
  unlinkTelegram,
} from "@/lib/actions";
import { getJson } from "@/lib/client/api";
import { queryKeys } from "@/lib/client/queries";
import type { TelegramStatusView } from "@/lib/types";
import { cn } from "@/lib/utils";

function Step({
  number,
  done,
  title,
  children,
}: {
  number: number;
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium tabular-nums",
          done ? "border-done bg-done text-white" : "text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <span className={cn("text-[14px]", done ? "text-muted-foreground" : "font-medium")}>
          {title}
        </span>
        {children}
      </div>
    </li>
  );
}

/** Approvals, updates and chat with your teammates, on Telegram. */
export function TelegramSection() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.telegram,
    queryFn: () => getJson<TelegramStatusView>("/api/telegram"),
  });
  const [token, setToken] = useState("");
  const [link, setLink] = useState<{ code: string; url: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.telegram });

  if (!status.data)
    return status.error ? (
      <p className="text-[14px] text-muted-foreground">
        The worker isn&apos;t running, so Telegram can&apos;t be set up.
      </p>
    ) : (
      <div className="h-24 animate-pulse rounded-xl bg-subtle" />
    );
  const telegram = status.data;

  if (telegram.connected && telegram.linked) {
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                telegram.problem ? "bg-destructive" : "bg-done",
              )}
            />
            <div className="flex min-w-0 flex-col">
              <span className="text-[14px] font-medium" data-testid="telegram-linked">
                Linked to {telegram.linkedName}
              </span>
              <span className="truncate text-[13px] text-muted-foreground">
                {telegram.problem ?? `Through @${telegram.botUsername}`}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await sendTelegramTest();
                  if (!result.ok) toast.error("Couldn't send it", { description: result.error });
                  else toast("Sent a message to your Telegram");
                })
              }
            >
              <Send />
              Send a test
            </Button>
          </div>
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          You get approvals with buttons, requests to take over, failures, and what your automations
          find. Message the bot to talk to the teammate you last talked to, or start with a name,
          like <span className="text-foreground">Rex: check the build</span>.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await unlinkTelegram();
                if (!result.ok) toast.error(result.error);
                setLink(null);
                await refresh();
              })
            }
          >
            Unlink this account
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await disconnectTelegram();
                if (!result.ok) toast.error(result.error);
                setLink(null);
                await refresh();
              })
            }
          >
            Disconnect the bot
          </Button>
        </div>
      </>
    );
  }

  return (
    <ol className="flex flex-col gap-5 rounded-xl border bg-card px-4 py-4">
      <Step number={1} done={telegram.connected} title="Make a Telegram bot">
        {!telegram.connected && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            In Telegram, open{" "}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-4"
            >
              @BotFather
            </a>
            , send <code className="rounded bg-subtle px-1 font-mono text-[12px]">/newbot</code>,
            and pick a name. It&apos;s yours alone: only the account you link can use it.
          </p>
        )}
      </Step>
      <Step
        number={2}
        done={telegram.connected}
        title={
          telegram.connected
            ? `Connected @${telegram.botUsername}`
            : "Paste the token @BotFather gives you"
        }
      >
        {!telegram.connected && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await connectTelegram(token);
                if (!result.ok) {
                  toast.error("Couldn't connect", { description: result.error });
                  return;
                }
                setToken("");
                await refresh();
              });
            }}
          >
            <Input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="123456789:AAH…"
              className="min-w-0 flex-1 font-mono text-[13px]"
              autoComplete="off"
              spellCheck={false}
              aria-label="Bot token"
              data-testid="telegram-token"
            />
            <Button type="submit" disabled={pending || !token.trim()}>
              {pending && <Loader2 className="animate-spin" />}
              Connect
            </Button>
          </form>
        )}
      </Step>
      <Step number={3} done={false} title="Link your Telegram account">
        {telegram.connected &&
          (link ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    Open Telegram <ExternalLink />
                  </a>
                </Button>
                <span className="text-[13px] text-muted-foreground">or send the bot</span>
                <code
                  className="rounded-lg bg-subtle px-2.5 py-1.5 font-mono text-[13px]"
                  data-testid="telegram-link-code"
                >
                  /start {link.code}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy"
                  onClick={() => void navigator.clipboard.writeText(`/start ${link.code}`)}
                >
                  <Copy />
                </Button>
              </div>
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Waiting for your message. The code
                works for 15 minutes.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await telegramLinkCode();
                    if (!result.ok) toast.error(result.error);
                    else setLink(result.data);
                  })
                }
              >
                {pending && <Loader2 className="animate-spin" />}
                Get a link code
              </Button>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await disconnectTelegram();
                    await refresh();
                  })
                }
              >
                Use another bot
              </Button>
            </div>
          ))}
        {telegram.problem && <p className="text-[13px] text-destructive">{telegram.problem}</p>}
      </Step>
    </ol>
  );
}
