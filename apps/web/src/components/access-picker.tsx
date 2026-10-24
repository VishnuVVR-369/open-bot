"use client";

import { Check } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { Switch } from "@/components/ui/switch";
import { useAppState } from "@/lib/client/queries";
import { cn } from "@/lib/utils";

/** Every teammate, or the ones you pick. */
export function AccessPicker({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
}) {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  const everyone = value === null;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">Every teammate can use it</span>
          <span className="text-[12.5px] text-muted-foreground">
            Including teammates you add later.
          </span>
        </span>
        <Switch
          checked={everyone}
          onCheckedChange={(checked) => onChange(checked ? null : [])}
          aria-label="Every teammate can use it"
        />
      </label>
      {!everyone && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Teammates who can use it">
          {bots.map((bot) => {
            const on = value.includes(bot.id);
            return (
              <button
                key={bot.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? value.filter((id) => id !== bot.id) : [...value, bot.id])
                }
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-full border pr-3 pl-1 text-[13px] transition-colors",
                  on
                    ? "border-foreground/30 bg-foreground/[0.06] text-foreground"
                    : "text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                )}
              >
                <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                {bot.name}
                {on && <Check className="size-3.5" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
