"use client";

import { MAX_GROUP_TEAMMATES } from "@open-bot/api";
import { Check, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { COMPOSER_INPUT_ID } from "@/features/chat";
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
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import type { BotSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export function NewGroupDialog({ bots }: { bots: BotSummary[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  // Set when the dialog closes because the group was made, and the app moves to its chat.
  const created = useRef(false);

  const full = selected.length >= MAX_GROUP_TEAMMATES;

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length < MAX_GROUP_TEAMMATES
          ? [...current, id]
          : current,
    );
  }

  function submit() {
    startTransition(async () => {
      const result = await attempt(api.chats.createGroup({ title, botIds: selected }));
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      created.current = true;
      setOpen(false);
      setTitle("");
      setSelected([]);
      router.push(`/chats/${result.data.chatId}`);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A group made after the dialog was already closed mustn't change the next close.
        if (next) created.current = false;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="New group chat">
          <Plus />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          // The new chat is open by now (it renders with the close), so focus goes to its message
          // box rather than back to the sidebar's button, which would close the @mention menu of
          // anything typed there meanwhile. Focus you already moved stays where it is.
          if (!created.current) return;
          created.current = false;
          event.preventDefault();
          if (document.activeElement === document.body)
            document.getElementById(COMPOSER_INPUT_ID)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>New group chat</DialogTitle>
          <DialogDescription>
            Your message goes to the lead teammate, or to whoever you @mention. They hand work to
            each other when it fits someone else&apos;s job.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-title">Name</Label>
            <Input
              id="group-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Launch week"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Teammates</Label>
            <div className="-mx-1 flex max-h-[min(40vh,320px)] flex-col gap-1 overflow-y-auto px-1 py-0.5">
              {bots.map((bot) => {
                const checked = selected.includes(bot.id);
                return (
                  <button
                    type="button"
                    key={bot.id}
                    role="checkbox"
                    aria-checked={checked}
                    disabled={full && !checked}
                    onClick={() => toggle(bot.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
                      checked && "border-foreground/40 bg-muted",
                    )}
                  >
                    <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium">{bot.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{bot.role}</span>
                    </span>
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-md border",
                        checked && "border-foreground bg-foreground text-background",
                      )}
                    >
                      {checked && <Check className="size-3.5" />}
                    </span>
                  </button>
                );
              })}
            </div>
            {full && (
              <p className="text-xs text-muted-foreground">
                A group can have up to {MAX_GROUP_TEAMMATES} teammates.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || selected.length < 2 || !title.trim()}>
            Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
