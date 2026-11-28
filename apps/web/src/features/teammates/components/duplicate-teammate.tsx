"use client";

import { copyName } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppState } from "@/features/app-shell";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";

/** Make a new teammate set up like this one. Open it with `trigger`, or control it with `open`. */
export function DuplicateTeammateDialog({
  teammate,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  teammate: { id: string; name: string };
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { data: state } = useAppState();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [name, setName] = useState("");
  const [copyMemory, setCopyMemory] = useState(true);
  const [pending, startTransition] = useTransition();
  // One copy per ask: asking again after an answer that never came names the same id, so the
  // server answers with the copy the first ask made (under the first ask's name) instead of a
  // second one. Opening the dialog again, or a refusal, which made nothing, starts a new ask.
  const sent = useRef<{ copyId: string; name: string } | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    sent.current = null;
    setName(copyName(teammate.name, state?.teammates.map((b) => b.name) ?? []));
    setCopyMemory(true);
    // Only when the dialog opens, so typing isn't undone by a state refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, teammate.id, teammate.name]);

  function submit() {
    startTransition(async () => {
      const ask = (sent.current ??= { copyId: crypto.randomUUID(), name: name.trim() });
      const result = await attempt(
        api.teammates.duplicate({
          teammateId: teammate.id,
          name,
          copyMemory,
          copyId: ask.copyId,
        }),
      );
      if (!result.ok) {
        if (result.refused) sent.current = null;
        toast.error("Couldn't duplicate the teammate", { description: result.error });
        return;
      }
      sent.current = null;
      await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
      setOpen(false);
      if (result.data.memoryCopied) {
        toast(`${ask.name} is ready`, {
          description: `Set up like ${teammate.name}. Their automations start off.`,
        });
      } else {
        toast.warning(`${ask.name} is ready, without ${teammate.name}'s memory`, {
          description: "The computer couldn't copy it. You can paste it into their Memory tab.",
        });
      }
      router.push(`/chats/${result.data.chatId}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate {teammate.name}</DialogTitle>
          <DialogDescription>
            The new teammate gets {teammate.name}&apos;s job and instructions, their own skills,
            what they may do without asking, and their schedules and page watches, turned off. Chats
            and webhooks stay with {teammate.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !pending) submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="duplicate-name">Name</Label>
            <Input
              id="duplicate-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              autoFocus
              data-testid="duplicate-name"
            />
          </div>
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Copy their memory</span>
              <span className="text-[13px] text-muted-foreground">
                What {teammate.name} has learned about you and how you like things done, including
                lessons from your feedback.
              </span>
            </span>
            <Switch
              checked={copyMemory}
              onCheckedChange={setCopyMemory}
              className="mt-0.5"
              data-testid="duplicate-memory"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || pending}
              data-testid="duplicate-confirm"
            >
              {pending && <Loader2 className="animate-spin" />}
              Duplicate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
