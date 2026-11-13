"use client";

import { ChevronDown } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type ScreenInfo, useComputer } from "../hooks";
import { activityLabel, ActivityDot } from "./screen-status";

/** How many screens show as tabs before the rest move into a menu. */
const VISIBLE_SCREENS = 4;

function ScreenTab({
  info,
  selected,
  onSelect,
}: {
  info: ScreenInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 text-[12.5px] font-medium transition-colors",
        selected
          ? "border-transparent bg-card text-foreground shadow-raised"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      data-testid={`screen-tab-${info.bot.slug}`}
    >
      <BotAvatar name={info.bot.name} color={info.bot.color} emoji={info.bot.emoji} size="xs" />
      <span className="max-w-[112px] truncate">{info.bot.name}</span>
      {info.activity === "working" || info.activity === "you" ? (
        <ActivityDot activity={info.activity} className="size-1.5" />
      ) : info.requests.length > 0 ? (
        <span className="size-1.5 shrink-0 rounded-full bg-attention" aria-label="Needs you" />
      ) : null}
    </button>
  );
}

/**
 * Tabs for switching between screens. The selected screen and the busy ones always get a tab;
 * the rest wait in a "+N" menu, so the row never runs off the edge.
 */
export function ScreenPicker({
  botIds,
  value,
  onChange,
  initial,
  className,
}: {
  botIds: string[];
  value: string | null;
  onChange: (screenId: string) => void;
  initial?: AppState;
  className?: string;
}) {
  const { screen } = useComputer(initial);
  const infos = botIds.map(screen).filter((info): info is ScreenInfo => info !== null);
  if (infos.length < 2) return null;

  const shown = new Set<string>();
  const want = (info: ScreenInfo) => {
    if (shown.size < VISIBLE_SCREENS) shown.add(info.bot.id);
  };
  const awake = (info: ScreenInfo) => info.activity !== "asleep" && info.activity !== "offline";
  // With one spare tab or less, show them all rather than a "+1" menu.
  const overflow = infos.length > VISIBLE_SCREENS + 1;
  if (overflow) {
    infos.filter((info) => info.bot.id === value).forEach(want);
    infos.filter((info) => info.activity === "you" || info.activity === "working").forEach(want);
    infos.filter(awake).forEach(want);
    infos.forEach(want);
  }
  const visible = overflow ? infos.filter((info) => shown.has(info.bot.id)) : infos;
  const hidden = overflow ? infos.filter((info) => !shown.has(info.bot.id)) : [];

  return (
    <div
      role="tablist"
      aria-label="Screens"
      className={cn("-mx-1 flex min-w-0 items-center gap-1 px-1 pb-0.5", className)}
    >
      {visible.map((info) => (
        <ScreenTab
          key={info.bot.id}
          info={info}
          selected={info.bot.id === value}
          onSelect={() => onChange(info.bot.id)}
        />
      ))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
              aria-label={`${hidden.length} more screens`}
              data-testid="more-screens"
            >
              +{hidden.length}
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-56">
            {hidden.map((info) => (
              <DropdownMenuItem key={info.bot.id} onSelect={() => onChange(info.bot.id)}>
                <BotAvatar
                  name={info.bot.name}
                  color={info.bot.color}
                  emoji={info.bot.emoji}
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate">{info.bot.name}</span>
                <span className="text-[12px] text-muted-foreground">{activityLabel(info)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
