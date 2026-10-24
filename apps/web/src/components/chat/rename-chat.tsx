"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { renameChat } from "@/lib/actions";

export function RenameChatDialog({
  chat,
  open,
  onOpenChange,
}: {
  chat: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(chat.title);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) setTitle(chat.title);
  }, [open, chat.title]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const next = title.trim();
            if (!next || pending) return;
            startTransition(async () => {
              const result = await renameChat(chat.id, next);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              onOpenChange(false);
            });
          }}
        >
          <Input
            aria-label="Chat name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            data-testid="rename-chat-input"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || pending}>
              {pending && <Loader2 className="animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
