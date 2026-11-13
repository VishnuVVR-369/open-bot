"use client";

import { EGRESS_OPTIONS, type EgressMode } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { attempt } from "@/lib/client/mutate";
import { useAppState } from "@/lib/client/queries";
import { api, orpc } from "@/lib/client/rpc";
import { cn } from "@/lib/utils";
import { Choice } from "./choice";

export function BrowsingSection() {
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
                const result = await attempt(
                  api.egress.setMode({ mode: option.value as EgressMode }),
                );
                if (!result.ok) toast.error(result.error);
                await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
              })
            }
          />
        ))}
      </div>
    </>
  );
}
