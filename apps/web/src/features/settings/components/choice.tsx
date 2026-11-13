"use client";

import { cn } from "@/lib/utils";

export function Choice({
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
