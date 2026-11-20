"use client";

import { isOwnerLease } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MousePointer2, Undo2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { releaseScreenNow } from "@/lib/client/screens";
import { useComputer } from "../hooks";

export function HandBackButton({
  screenId,
  teammateName,
  size = "default",
}: {
  screenId: string;
  teammateName: string;
  size?: "default" | "lg";
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const { screen } = useComputer();
  const lease = screen(screenId)?.lease ?? null;
  const protectedCode =
    isOwnerLease(lease) && (lease.kind === "user-code" || lease.pausedForSafety);

  function submit(clearCode = false) {
    startTransition(async () => {
      await releaseScreenNow(queryClient, screenId);
      const result = await attempt(
        api.screens.handBack({ screenId, note: note.trim() || null, clearCode }),
      );
      if (!result.ok) {
        toast.error(result.error);
        await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
        return;
      }
      setOpen(false);
      setNote("");
      toast("Handed back", { description: `${teammateName} can use the screen again.` });
      await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size={size}
          className="bg-attention text-black hover:bg-attention/85"
          data-testid="hand-back"
        >
          <Undo2 />
          Hand back
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Hand the screen back to {teammateName}</span>
            <span className="text-[13px] text-muted-foreground">
              Leave a note so {teammateName} knows what you did. Optional.
            </span>
          </div>
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Signed in to GitHub. Carry on."
            className="min-h-20 resize-none"
            data-testid="hand-back-note"
          />
          <Button type="submit" disabled={pending} data-testid="hand-back-confirm">
            {pending && <Loader2 className="animate-spin" />}
            Hand back
          </Button>
          {protectedCode && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (
                  window.confirm(
                    "Clear the code and hand back? If the computer restarted, its browser pages will be discarded to keep the forgotten code private.",
                  )
                )
                  submit(true);
              }}
            >
              Clear the code and hand back
            </Button>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function TakeOverButton({
  screenId,
  size = "default",
  label = "Take over",
}: {
  screenId: string;
  size?: "default" | "lg" | "sm";
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  return (
    <Button
      size={size}
      variant="outline"
      data-testid="take-over"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await attempt(api.screens.takeOver({ screenId }));
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <MousePointer2 />}
      {label}
    </Button>
  );
}
