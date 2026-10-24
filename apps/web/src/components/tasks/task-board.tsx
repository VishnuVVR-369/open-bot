"use client";

import { useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { CalendarDays, Plus, StickyNote } from "lucide-react";
import { useState, type DragEvent } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { createTask, updateTask } from "@/lib/actions";
import { queryKeys, useAppState, useTasks } from "@/lib/client/queries";
import type { BotSummary, TaskView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, TaskDialog } from "./task-dialog";

const COLUMNS: TaskView["status"][] = ["todo", "doing", "done"];

function Due({ dueOn, done }: { dueOn: string; done: boolean }) {
  const days = differenceInCalendarDays(parseISO(dueOn), new Date());
  const date = parseISO(dueOn);
  const label =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days === -1
          ? "Yesterday"
          : format(date, date.getFullYear() === new Date().getFullYear() ? "d MMM" : "d MMM yyyy");
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-md px-1.5 py-px text-[12px]",
        done
          ? "text-muted-foreground"
          : days < 0
            ? "bg-destructive/10 text-destructive"
            : days === 0
              ? "bg-waiting/12 text-waiting"
              : "text-muted-foreground",
      )}
    >
      <CalendarDays className="size-3" />
      {label}
    </span>
  );
}

function Card({
  task,
  owner,
  onOpen,
  onDragStart,
  onDropBefore,
}: {
  task: TaskView;
  owner: BotSummary | undefined;
  onOpen: () => void;
  onDragStart: (event: DragEvent) => void;
  onDropBefore: (event: DragEvent) => void;
}) {
  const [over, setOver] = useState(false);
  const done = task.status === "done";
  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        onDropBefore(event);
      }}
      className={cn(
        "relative",
        over &&
          "before:absolute before:inset-x-1 before:-top-1 before:h-0.5 before:rounded-full before:bg-foreground/50",
      )}
      data-testid="task"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-grab flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 text-left shadow-xs transition-colors hover:border-foreground/20 active:cursor-grabbing"
      >
        <span
          className={cn(
            "text-[14px] leading-snug break-words",
            done && "text-muted-foreground line-through decoration-muted-foreground/40",
          )}
        >
          {task.title}
        </span>
        {(owner || task.dueOn || task.notes) && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {owner && (
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <BotAvatar name={owner.name} color={owner.color} emoji={owner.emoji} size="xs" />
                {owner.name}
              </span>
            )}
            {task.dueOn && <Due dueOn={task.dueOn} done={done} />}
            {task.notes && (
              <StickyNote className="size-3.5 text-muted-foreground" aria-label="Has notes" />
            )}
          </span>
        )}
      </button>
    </li>
  );
}

function QuickAdd({ onAdded }: { onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  if (!adding)
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" />
        Add a task
      </button>
    );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!title.trim()) return;
        const result = await createTask({ title });
        if (!result.ok) {
          toast.error("Couldn't add it", { description: result.error });
          return;
        }
        setTitle("");
        onAdded();
      }}
    >
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => !title.trim() && setAdding(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setTitle("");
            setAdding(false);
          }
        }}
        maxLength={200}
        placeholder="What needs doing? Press Enter"
        aria-label="New task"
        className="h-9 bg-card text-[14px]"
      />
    </form>
  );
}

/** The team's task board: To do, Doing and Done, with drag and drop between them. */
export function TaskBoard() {
  const { data: state } = useAppState();
  const { data: tasks, isLoading } = useTasks();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ task: TaskView | null; open: boolean }>({
    task: null,
    open: false,
  });
  const [overColumn, setOverColumn] = useState<TaskView["status"] | null>(null);
  const bots = state?.bots ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });

  /** Moves a task, showing it in place right away. */
  async function move(id: string, status: TaskView["status"], position: number) {
    queryClient.setQueryData<TaskView[]>(queryKeys.tasks, (current) =>
      current?.map((task) => (task.id === id ? { ...task, status, position } : task)),
    );
    const result = await updateTask(id, { status, position });
    if (!result.ok) toast.error("Couldn't move it", { description: result.error });
    refresh();
  }

  if (isLoading || !tasks)
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {COLUMNS.map((column) => (
          <Skeleton key={column} className="h-64 rounded-xl" />
        ))}
      </div>
    );

  const columns = COLUMNS.map((status) => ({
    status,
    tasks: tasks
      .filter((task) => task.status === status)
      .sort((a, b) =>
        status === "done"
          ? (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
          : a.position - b.position,
      ),
  }));

  const dragId = (event: DragEvent) => event.dataTransfer.getData("text/task-id");

  return (
    <>
      <div className="grid items-start gap-4 md:grid-cols-3">
        {columns.map((column) => (
          <section
            key={column.status}
            aria-label={STATUS_LABELS[column.status]}
            data-testid={`column-${column.status}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOverColumn(column.status);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverColumn(null);
            }}
            onDrop={(event) => {
              setOverColumn(null);
              const id = dragId(event);
              if (!id || event.defaultPrevented) return;
              const last = column.tasks.filter((task) => task.id !== id).at(-1);
              void move(id, column.status, (last?.position ?? 0) + 1);
            }}
            className={cn(
              "flex flex-col gap-2 rounded-xl md:min-h-40 bg-subtle/60 p-2 transition-colors dark:bg-white/[0.03]",
              overColumn === column.status && "bg-subtle ring-1 ring-foreground/15",
            )}
          >
            <h2 className="flex items-center gap-2 px-1.5 pt-1 pb-0.5 text-[13px] font-medium">
              <span
                className={cn(
                  "size-2 rounded-full",
                  column.status === "todo" && "bg-muted-foreground/40",
                  column.status === "doing" && "bg-manual",
                  column.status === "done" && "bg-done",
                )}
              />
              {STATUS_LABELS[column.status]}
              <span className="font-normal text-muted-foreground tabular-nums">
                {column.tasks.length}
              </span>
            </h2>
            <ol className="flex flex-col gap-2">
              {column.tasks.map((task, index) => (
                <Card
                  key={task.id}
                  task={task}
                  owner={bots.find((bot) => bot.id === task.ownerBotId)}
                  onOpen={() => setEditing({ task, open: true })}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/task-id", task.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDropBefore={(event) => {
                    const id = dragId(event);
                    event.preventDefault();
                    setOverColumn(null);
                    if (!id || id === task.id) return;
                    const previous = column.tasks[index - 1];
                    const before =
                      previous && previous.id !== id ? previous.position : task.position - 1;
                    void move(id, column.status, (before + task.position) / 2);
                  }}
                />
              ))}
            </ol>
            {column.tasks.length === 0 && column.status !== "todo" && (
              <p className="px-2 py-3 text-center text-[13px] text-muted-foreground">
                {column.status === "doing" ? "Nothing in progress." : "Nothing finished yet."}
              </p>
            )}
            {column.status === "todo" && <QuickAdd onAdded={refresh} />}
          </section>
        ))}
      </div>
      {tasks.length === 0 && (
        <p className="text-center text-[13.5px] text-muted-foreground">
          Add what needs doing, or give a goal to your chief of staff and they&apos;ll fill the
          board.
        </p>
      )}
      {editing.task && (
        <TaskDialog
          key={editing.task.id}
          task={editing.task}
          bots={bots}
          open={editing.open}
          onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
          onSaved={refresh}
        />
      )}
    </>
  );
}

/** Opens a new task. */
export function NewTaskButton() {
  const { data: state } = useAppState();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <>
      <Button
        onClick={() => {
          setKey((value) => value + 1);
          setOpen(true);
        }}
      >
        <Plus />
        New task
      </Button>
      <TaskDialog
        key={key}
        task={null}
        bots={state?.bots ?? []}
        open={open}
        onOpenChange={setOpen}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })}
      />
    </>
  );
}
