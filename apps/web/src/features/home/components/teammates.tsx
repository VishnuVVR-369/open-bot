"use client";

import { BOT_COLORS, TEAMMATE_TEMPLATES } from "@open-bot/domain";
import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/features/app-shell";
import { isComputerOnline, teammateStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * Your teammates. On a wide screen the sidebar already lists them, so Home only shows them there
 * to help you create the first one.
 */
export function Teammates() {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  const online = isComputerOnline(state);
  return (
    <section
      className={cn("flex flex-col gap-3", bots.length > 0 && "lg:hidden")}
      aria-label="Teammates"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          Teammates
        </h2>
        {bots.length > 0 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/bots/new">
              <Plus />
              New teammate
            </Link>
          </Button>
        )}
      </div>
      {bots.length === 0 ? (
        <Link
          href="/bots/new"
          className="group flex flex-col gap-4 rounded-2xl border border-dashed bg-card px-6 py-8 transition-colors hover:border-foreground/30"
        >
          <div className="flex -space-x-2">
            {TEAMMATE_TEMPLATES.slice(0, 3).map((template, index) => (
              <BotAvatar
                key={template.id}
                name={template.name}
                emoji={template.emoji}
                color={BOT_COLORS[index * 2]!}
                size="md"
                className="rounded-[10px] ring-4 ring-card"
              />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[16px] font-semibold">Create your first teammate</span>
            <span className="max-w-md text-[14px] text-muted-foreground">
              Give them a job, like research, your inbox or shopping. They work on the shared
              computer while you do other things.
            </span>
          </div>
          <span className="flex items-center gap-1.5 text-[14px] font-medium">
            Get started{" "}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {bots.map((bot) => {
            const status = teammateStatus(bot, online);
            return (
              <Link
                key={bot.id}
                href={bot.directChatId ? `/chats/${bot.directChatId}` : `/bots/${bot.id}`}
                className="group flex min-w-0 items-center gap-3 rounded-xl bg-card px-3 py-2.5 shadow-raised transition-shadow hover:shadow-float"
                data-testid="teammate-card"
              >
                <BotAvatar
                  name={bot.name}
                  color={bot.color}
                  emoji={bot.emoji}
                  size="md"
                  activity={status.activity}
                  className="[--avatar-ring:var(--card)]"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 text-[14px] font-semibold">{bot.name}</span>
                    {/* Their job, where there is room; the line below is only their status. */}
                    <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                      {bot.role}
                    </span>
                    {bot.isPrimary && (
                      <span className="shrink-0 self-center rounded-full bg-subtle px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                        Lead
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12.5px] text-muted-foreground",
                      status.needsYou && "text-attention-ink",
                    )}
                  >
                    {status.label}
                  </span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
