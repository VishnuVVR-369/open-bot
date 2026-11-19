"use client";

import { CalendarDays, Check } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { dayOf, RANGE_PRESETS, rangeLabel, type RangeChoice } from "../ranges";

/**
 * The page's filters, kept in its address: reading them, and replacing them without a new
 * history entry per keystroke or a jump back to the top.
 */
export function useAddress() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = (next: URLSearchParams) => {
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    set(next);
  };
  return { params: new URLSearchParams(params), set, setParam };
}

/** "All" is the empty choice; Radix's select can't hold an empty value. */
const ALL = "__all";

/** A filter with a fixed list of choices, "All" first. */
export function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
  className,
  testId,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  allLabel: string;
  onChange: (value: string | null) => void;
  className?: string;
  testId?: string;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn("max-w-full min-w-0", value && "border-ring/40 font-medium", className)}
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Presets as rows, then a range of whole days of your own. */
export function RangePicker({
  choice,
  onChange,
  allowAny = true,
  testId,
}: {
  choice: RangeChoice;
  onChange: (choice: RangeChoice) => void;
  allowAny?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const today = dayOf(new Date());
  const [from, setFrom] = useState(choice.kind === "days" ? (choice.from ?? "") : "");
  const [to, setTo] = useState(choice.kind === "days" ? (choice.to ?? "") : "");
  const pick = (next: RangeChoice) => {
    onChange(next);
    setOpen(false);
  };
  const row = (selected: boolean, label: string, next: RangeChoice) => (
    <button
      key={label}
      type="button"
      onClick={() => pick(next)}
      className={cn(
        "flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-[13.5px] hover:bg-subtle",
        selected && "font-semibold",
      )}
    >
      {label}
      {selected && <Check className="size-4" strokeWidth={2.5} />}
    </button>
  );
  const customValid = (from || to) && (!from || !to || from <= to);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 text-sm font-normal",
            choice.kind !== "any" && "border-ring/40 font-medium",
          )}
          data-testid={testId}
        >
          <CalendarDays className="text-muted-foreground" />
          {rangeLabel(choice)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {allowAny && row(choice.kind === "any", "Any time", { kind: "any" })}
        {RANGE_PRESETS.map((preset) =>
          row(choice.kind === "preset" && choice.id === preset.id, preset.label, {
            kind: "preset",
            id: preset.id,
          }),
        )}
        <form
          className="mt-1.5 flex flex-col gap-2 border-t px-1 pt-2.5 pb-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (customValid) pick({ kind: "days", from: from || null, to: to || null });
          }}
        >
          <span className="text-[12px] font-medium text-muted-foreground">Custom dates</span>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              aria-label="From"
              value={from}
              max={to || today}
              onChange={(event) => setFrom(event.target.value)}
              className="h-8 px-2 text-[12.5px]"
            />
            <Input
              type="date"
              aria-label="To"
              value={to}
              min={from || undefined}
              max={today}
              onChange={(event) => setTo(event.target.value)}
              className="h-8 px-2 text-[12.5px]"
            />
          </div>
          <Button type="submit" size="sm" disabled={!customValid}>
            Show these dates
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** A section that couldn't load, with a way to try again. */
export function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13.5px]">
      <span className="text-muted-foreground">Couldn&apos;t load this. {error.message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
