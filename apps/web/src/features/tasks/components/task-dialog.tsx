"use client";

import {
  TASK_NOTES_MAX,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  wasAsked,
} from "@open-bot/domain";
import { Loader2, MessageSquare, Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { TeammateAvatar } from "@/components/teammate-avatar";
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
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import type { TeammateSummary, TaskView } from "@/lib/types";
import { startKeys } from "../pending";

const NOBODY = "you";

/** What the dialog edits, as it's sent. */
type TaskFields = Pick<TaskView, "title" | "notes" | "ownerTeammateId" | "dueOn" | "status">;

/**
 * The fields that differ from what was last saved, so a field changed elsewhere meanwhile (a
 * teammate reassigned the task, say) isn't written back over. Title and notes are trimmed by the
 * worker, so whitespace alone isn't a change.
 */
function changedFields(saved: TaskFields, now: TaskFields): Partial<TaskFields> {
  const changes: Partial<TaskFields> = {};
  if (now.title.trim() !== saved.title.trim()) changes.title = now.title;
  if (now.notes.trim() !== saved.notes.trim()) changes.notes = now.notes;
  if (now.ownerTeammateId !== saved.ownerTeammateId) changes.ownerTeammateId = now.ownerTeammateId;
  if (now.dueOn !== saved.dueOn) changes.dueOn = now.dueOn;
  if (now.status !== saved.status) changes.status = now.status;
  return changes;
}

/** A new task, or one to edit, with who owns it and when it's due. */
export function TaskDialog({
  task,
  teammates,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Null for a new task. */
  task: TaskView | null;
  teammates: TeammateSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [owner, setOwner] = useState(task?.ownerTeammateId ?? NOBODY);
  const [dueOn, setDueOn] = useState(task?.dueOn ?? "");
  const [status, setStatus] = useState<TaskView["status"]>(task?.status ?? "todo");
  const [pending, startTransition] = useTransition();
  // The task this dialog saved, and its fields as saved: a new task gets its id once it's added,
  // so trying to start it again (after a start that failed) updates it instead of adding another.
  const [saved, setSaved] = useState<{ id: string; fields: TaskFields } | null>(
    task && {
      id: task.id,
      fields: {
        title: task.title,
        notes: task.notes,
        ownerTeammateId: task.ownerTeammateId,
        dueOn: task.dueOn,
        status: task.status,
      },
    },
  );
  const router = useRouter();
  const ownerTeammate = teammates.find((teammate) => teammate.id === owner);
  // The chat is the saved owner's, whoever the form now names.
  const chatOwner = teammates.find((teammate) => teammate.id === task?.ownerTeammateId);

  function save(then?: "start") {
    startTransition(async () => {
      const fields: TaskFields = {
        title,
        notes,
        ownerTeammateId: owner === NOBODY ? null : owner,
        dueOn: dueOn || null,
        status,
      };
      let id: string;
      if (!saved) {
        const { status: _, ...input } = fields;
        const result = await attempt(api.tasks.create(input));
        if (!result.ok) {
          toast.error("Couldn't save the task", { description: result.error });
          return;
        }
        id = result.data.id;
      } else {
        id = saved.id;
        const changes = changedFields(saved.fields, fields);
        if (Object.keys(changes).length > 0) {
          const result = await attempt(api.tasks.update({ taskId: id, ...changes }));
          if (!result.ok) {
            toast.error("Couldn't save the task", { description: result.error });
            return;
          }
        }
      }
      setSaved({ id, fields });
      if (then === "start" && fields.ownerTeammateId) {
        // The owner it asks is the one the button named: a task given to someone else meanwhile
        // is refused. A retry sends the same start id, so a lost answer never asks twice.
        const expectedOwnerId = fields.ownerTeammateId;
        const started = await attempt(
          api.tasks.start({
            taskId: id,
            startId: startKeys.for(id, expectedOwnerId),
            expectedOwnerId,
          }),
        );
        onSaved();
        if (!started.ok) {
          toast.error("Couldn't start it", { description: started.error });
          return;
        }
        startKeys.done(id, expectedOwnerId);
        toast(`${ownerTeammate?.name ?? "They"} started on it`, {
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
      const result = await attempt(api.tasks.remove({ taskId: task.id }));
      if (!result.ok) toast.error("Couldn't delete it", { description: result.error });
      onSaved();
      onOpenChange(false);
    });
  }

  const canStart = ownerTeammate && status !== "done";
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
            <DialogTitle>{saved ? "Task" : "New task"}</DialogTitle>
            <DialogDescription>
              {task?.createdBy === "teammate"
                ? `Added by ${teammates.find((teammate) => teammate.id === task.createdByTeammateId)?.name ?? "a teammate"}.`
                : "Give it to a teammate to have them do it, or keep it for yourself."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={TASK_TITLE_MAX}
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
              maxLength={TASK_NOTES_MAX}
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
                  {teammates.map((teammate) => (
                    <SelectItem key={teammate.id} value={teammate.id}>
                      <TeammateAvatar
                        name={teammate.name}
                        color={teammate.color}
                        emoji={teammate.emoji}
                        size="xs"
                      />
                      {teammate.name}
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
                    {TASK_STATUSES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {TASK_STATUS_LABELS[value]}
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
              {task?.chatId && chatOwner && (
                <Button type="button" variant="ghost" size="sm" asChild>
                  <Link href={`/chats/${task.chatId}`}>
                    <MessageSquare />
                    {chatOwner.name}&apos;s chat
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
                  {wasAsked(task, owner)
                    ? `Ask ${ownerTeammate.name} again`
                    : `Ask ${ownerTeammate.name} to start`}
                </Button>
              )}
              <Button type="submit" disabled={pending || !title.trim()}>
                {pending && <Loader2 className="animate-spin" />}
                {saved ? "Save" : "Add task"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
