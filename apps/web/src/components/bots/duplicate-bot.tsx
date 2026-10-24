"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
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
import { duplicateBot } from "@/lib/actions";
import { queryKeys, useAppState } from "@/lib/client/queries";

/** "Iris 2", or the next number no teammate uses yet. */
function copyName(name: string, taken: string[]): string {
  const base = name.replace(/\s+\d+$/, "");
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 2; ; i += 1) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Make a new teammate set up like this one. Open it with `trigger`, or control it with `open`. */
export function DuplicateBotDialog({
  bot,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  bot: { id: string; name: string };
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
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    setName(copyName(bot.name, state?.bots.map((b) => b.name) ?? []));
    setCopyMemory(true);
    // Only when the dialog opens, so typing isn't undone by a state refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot.name]);

  function submit() {
    startTransition(async () => {
      const result = await duplicateBot(bot.id, { name, copyMemory });
      if (!result.ok) {
        toast.error("Couldn't duplicate the teammate", { description: result.error });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
      setOpen(false);
      if (result.data.memoryCopied) {
        toast(`${name.trim()} is ready`, {
          description: `Set up like ${bot.name}. Their automations start paused.`,
        });
      } else {
        toast.warning(`${name.trim()} is ready, without ${bot.name}'s memory`, {
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
          <DialogTitle>Duplicate {bot.name}</DialogTitle>
          <DialogDescription>
            The new teammate gets {bot.name}&apos;s job and instructions, their own skills, what
            they may do without asking, and their schedules and page watches, paused. Chats and
            webhooks stay with {bot.name}.
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
                What {bot.name} has learned about you and how you like things done, including
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
