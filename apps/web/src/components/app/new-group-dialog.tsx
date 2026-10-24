"use client";

import { Check, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
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
import { createGroupChat } from "@/lib/actions";
import type { BotSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export function NewGroupDialog({ bots }: { bots: BotSummary[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  function submit() {
    startTransition(async () => {
      const result = await createGroupChat({ title, botIds: selected });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setOpen(false);
      setTitle("");
      setSelected([]);
      router.push(`/chats/${result.data.chatId}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="New group chat">
          <Plus />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
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
                    onClick={() => toggle(bot.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted",
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
