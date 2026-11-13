"use client";

import { integration, type AccountCapability, type AccountConnectionKind } from "@open-bot/domain";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** The switches for what teammates may do with an account. */
export function CapabilityPicker({
  kind,
  value,
  onChange,
}: {
  kind: AccountConnectionKind;
  value: AccountCapability[];
  onChange: (value: AccountCapability[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3" role="group" aria-label="What teammates can do">
      {integration(kind).capabilities.map((option) => (
        <label
          key={option.capability}
          className={cn(
            "flex items-center justify-between gap-4",
            option.required ? "cursor-default" : "cursor-pointer",
          )}
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] font-medium">{option.label}</span>
            <span className="text-[12.5px] text-muted-foreground">{option.description}</span>
          </span>
          <Switch
            checked={option.required || value.includes(option.capability)}
            disabled={option.required}
            aria-label={option.label}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, option.capability]
                  : value.filter((entry) => entry !== option.capability),
              )
            }
          />
        </label>
      ))}
    </div>
  );
}
