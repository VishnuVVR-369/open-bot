"use client";

import { Loader2, MessageSquare, Play, Trash2 } from "lucide-react";
import Link from "next/link";
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTask, deleteTask, startTask, updateTask } from "@/lib/actions";
import type { BotSummary, TaskView } from "@/lib/types";

export const STATUS_LABELS: Record<TaskView["status"], string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

const NOBODY = "you";

/** A new task, or one to edit, with who owns it and when it's due. */
export function TaskDialog({
  task,
  bots,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Null for a new task. */
  task: TaskView | null;
  bots: BotSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [owner, setOwner] = useState(task?.ownerBotId ?? NOBODY);
  const [dueOn, setDueOn] = useState(task?.dueOn ?? "");
  const [status, setStatus] = useState<TaskView["status"]>(task?.status ?? "todo");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const ownerBot = bots.find((bot) => bot.id === owner);

  function save(then?: "start") {
    startTransition(async () => {
      const fields = {
        title,
        notes,
        ownerBotId: owner === NOBODY ? null : owner,
        dueOn: dueOn || null,
      };
      const result = task
        ? await updateTask(task.id, { ...fields, status })
        : await createTask(fields);
      if (!result.ok) {
        toast.error("Couldn't save the task", { description: result.error });
        return;
      }
      const id = task?.id ?? (result.data as { id: string }).id;
      if (then === "start") {
        const started = await startTask(id);
        if (!started.ok) {
          toast.error("Couldn't start it", { description: started.error });
          return;
        }
        toast(`${ownerBot?.name ?? "They"} started on it`, {
          action: started.data.chatId
            ? {
                label: "Watch",
                onClick: () => router.push(`/chats/${started.data.chatId}`),
              }
            : undefined,
        });
      }
      onSaved();
      onOpenChange(false);
    });
  }

  function remove() {
    if (!task) return;
    startTransition(async () => {
      const result = await deleteTask(task.id);
      if (!result.ok) toast.error("Couldn't delete it", { description: result.error });
      onSaved();
      onOpenChange(false);
    });
  }

  const canStart = ownerBot && status !== "done";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="task-dialog"
        // Opening a task to read it shouldn't select its title.
        onOpenAutoFocus={(event) => task && event.preventDefault()}
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{task ? "Task" : "New task"}</DialogTitle>
            <DialogDescription>
              {task?.createdBy === "bot"
                ? `Added by ${bots.find((bot) => bot.id === task.createdByBotId)?.name ?? "a teammate"}.`
                : "Give it to a teammate to have them do it, or keep it for yourself."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="Book flights to Tokyo"
              autoFocus={!task}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-notes">Notes</Label>
            <Textarea
              id="task-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={8000}
              placeholder="What done looks like, and anything they should know."
              className="min-h-24 text-[14px]"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label>Owner</Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger aria-label="Owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOBODY}>You</SelectItem>
                  {bots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="task-due">Due</Label>
              <Input
                id="task-due"
                type="date"
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
              />
            </div>
            {task && (
              <div className="flex flex-col gap-2">
                <Label>Status</Label>
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(value as TaskView["status"])}
                >
                  <SelectTrigger aria-label="Status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["todo", "doing", "done"] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {STATUS_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <div className="flex items-center gap-1">
              {task && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={pending}
                  onClick={remove}
                >
                  <Trash2 />
                  Delete
                </Button>
              )}
              {task?.chatId && ownerBot && (
                <Button type="button" variant="ghost" size="sm" asChild>
                  <Link href={`/chats/${task.chatId}`}>
                    <MessageSquare />
                    {ownerBot.name}&apos;s chat
                  </Link>
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {canStart && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !title.trim()}
                  onClick={() => save("start")}
                >
                  <Play className="fill-current" />
                  {task?.status === "doing"
                    ? `Ask ${ownerBot.name} again`
                    : `Ask ${ownerBot.name} to start`}
                </Button>
              )}
              <Button type="submit" disabled={pending || !title.trim()}>
                {pending && <Loader2 className="animate-spin" />}
                {task ? "Save" : "Add task"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
