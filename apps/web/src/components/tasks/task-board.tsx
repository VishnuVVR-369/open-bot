"use client";

import { useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { CalendarDays, ChevronDown, CircleCheck, Plus } from "lucide-react";
import { useState, type DragEvent } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createTask, updateTask } from "@/lib/actions";
import { useAppState, useApprovals, useTasks } from "@/lib/client/queries";
import { orpc } from "@/lib/client/rpc";
import type { BotSummary, TaskView } from "@/lib/types";
import { isComputerOnline, STATUS } from "@/lib/status";
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
          : format(date, date.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d, yyyy");
  const overdue = !done && days < 0;
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-md text-[12px]",
        overdue
          ? "bg-attention/12 px-1.5 py-px text-attention-ink"
          : !done && days === 0
            ? "font-medium text-foreground"
            : "text-muted-foreground",
      )}
      title={overdue ? "Overdue" : undefined}
    >
      <CalendarDays className="size-3" />
      {label}
    </span>
  );
}

/**
 * What holds a task up: you (an approval, a take over), or the computer being offline while a
 * teammate is on it.
 */
type Blocker = "approval" | "takeover" | "paused";

const BLOCKER_TEXT: Record<Blocker, string> = {
  approval: "Waiting for approval",
  takeover: "Waiting for you to take over",
  paused: STATUS.paused,
};

/** The owner's own mark, as the sidebar shows it: their initial on a round ink tile. */
function YouAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-foreground/85 to-foreground text-[10px] font-semibold text-background"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Card({
  task,
  owner,
  you,
  blocker,
  onOpen,
  onDragStart,
  onDropBefore,
}: {
  task: TaskView;
  owner: BotSummary | undefined;
  /** The owner's name, when the task is theirs: tasks without a teammate belong to them. */
  you: string | null;
  blocker: Blocker | null;
  onOpen: () => void;
  onDragStart: (event: DragEvent) => void;
  onDropBefore: (event: DragEvent) => void;
}) {
  const [over, setOver] = useState(false);
  const done = task.status === "done";
  const notes = task.notes.trim().replace(/\s+/g, " ");
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
        // Dark mode lifts cards a step above their column, which sits close to the card color.
        className="flex w-full cursor-grab flex-col gap-2 rounded-[10px] bg-card px-3.5 py-3 text-left shadow-raised transition-shadow hover:shadow-float active:cursor-grabbing dark:bg-popover"
      >
        {blocker && (
          <span
            className={cn(
              "flex items-center gap-1.5 text-[12px] font-medium",
              blocker === "paused" ? "text-muted-foreground" : "text-attention-ink",
            )}
            title={blocker === "paused" ? "Paused while the computer is offline" : undefined}
            data-testid="task-state"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                blocker === "paused" ? "bg-idle" : "bg-attention",
              )}
            />
            {BLOCKER_TEXT[blocker]}
          </span>
        )}
        <span className="flex items-start gap-2">
          {done && <CircleCheck className="mt-px size-4 shrink-0 text-done" aria-label="Done" />}
          <span className={cn("flex min-w-0 flex-col gap-0.5", done && "text-muted-foreground")}>
            <span className="text-[13.5px] leading-snug font-medium break-words">{task.title}</span>
            {notes && !done && (
              <span className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
                {notes}
              </span>
            )}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {owner ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <BotAvatar name={owner.name} color={owner.color} emoji={owner.emoji} size="xs" />
              {owner.name}
            </span>
          ) : you !== null ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <YouAvatar name={you} />
              You
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[12.5px] text-faint">
              <span className="size-5 rounded-[6px] border border-dashed border-foreground/20" />
              Unassigned
            </span>
          )}
          {task.dueOn && <Due dueOn={task.dueOn} done={done} />}
        </span>
      </button>
    </li>
  );
}

/** Which tasks the board shows: every task, yours, or the ones waiting on you or overdue. */
type Filter = "all" | "mine" | "attention";

function overdue(task: TaskView): boolean {
  return (
    task.status !== "done" &&
    task.dueOn !== null &&
    differenceInCalendarDays(parseISO(task.dueOn), new Date()) < 0
  );
}

/** A task's blocker that is waiting on you, rather than on the computer. */
function waitsOnYou(blocker: Blocker | null): boolean {
  return blocker === "approval" || blocker === "takeover";
}

/** How many finished tasks show before "Show N completed". */
const DONE_SHOWN = 4;

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
  const [showAllDone, setShowAllDone] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const { data: approvals } = useApprovals();
  const bots = state?.bots ?? [];
  /** A task whose chat waits on you says so on its card. */
  const online = !state || isComputerOnline(state);
  const blockerOf = (task: TaskView): Blocker | null => {
    if (task.status === "done") return null;
    if (task.chatId) {
      if (approvals?.some((a) => a.status === "pending" && a.chatId === task.chatId))
        return "approval";
      if (state?.takeoverRequests.some((request) => request.chatId === task.chatId))
        return "takeover";
    }
    // A teammate's task in progress can't move while the computer is offline.
    if (!online && task.status === "doing" && task.ownerBotId) return "paused";
    return null;
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });

  /** Moves a task, showing it in place right away. */
  async function move(id: string, status: TaskView["status"], position: number) {
    queryClient.setQueryData(orpc.tasks.list.queryKey(), (current) =>
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

  const blockers = new Map(tasks.map((task) => [task.id, blockerOf(task)]));
  const mine = (task: TaskView) => task.ownerBotId === null;
  const needsAttention = (task: TaskView) =>
    waitsOnYou(blockers.get(task.id) ?? null) || overdue(task);
  const counts = {
    mine: tasks.filter((task) => task.status !== "done" && mine(task)).length,
    attention: tasks.filter(needsAttention).length,
  };
  const shown = tasks.filter((task) =>
    filter === "mine" ? mine(task) : filter === "attention" ? needsAttention(task) : true,
  );

  const columns = COLUMNS.map((status) => ({
    status,
    tasks: shown
      .filter((task) => task.status === status)
      .sort((a, b) => {
        if (status === "done") return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
        // What waits on you leads its column, so it's seen first.
        const first =
          Number(waitsOnYou(blockers.get(b.id) ?? null)) -
          Number(waitsOnYou(blockers.get(a.id) ?? null));
        return first || a.position - b.position;
      }),
  }));

  const dragId = (event: DragEvent) => event.dataTransfer.getData("text/task-id");

  return (
    <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)} className="gap-4">
      <TabsList aria-label="Show tasks" data-testid="task-filters">
        <TabsTrigger value="all" className="px-3">
          All
        </TabsTrigger>
        <TabsTrigger value="mine" className="px-3">
          Mine ({counts.mine})
        </TabsTrigger>
        <TabsTrigger value="attention" className="px-3">
          Needs attention{counts.attention > 0 && ` (${counts.attention})`}
        </TabsTrigger>
      </TabsList>
      <TabsContent value={filter} className="flex flex-col gap-4">
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
                "flex flex-col gap-2 rounded-[14px] bg-subtle p-2 transition-colors md:min-h-40 dark:bg-white/[0.025]",
                overColumn === column.status && "ring-1 ring-foreground/15",
              )}
            >
              <h2 className="flex items-center gap-2 px-1.5 pt-1 pb-1 text-[13px] font-semibold">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    column.status === "todo" && "bg-muted-foreground/40",
                    column.status === "doing" && "bg-working",
                    column.status === "done" && "bg-done",
                  )}
                />
                {STATUS_LABELS[column.status]}
                <span className="ml-auto rounded-full bg-surface px-1.5 text-[11.5px] leading-[18px] font-medium text-muted-foreground tabular-nums shadow-raised dark:bg-white/[0.06] dark:shadow-none">
                  {column.tasks.length}
                </span>
              </h2>
              <ol className="flex flex-col gap-2">
                {(column.status === "done" && !showAllDone
                  ? column.tasks.slice(0, DONE_SHOWN)
                  : column.tasks
                ).map((task) => (
                  <Card
                    key={task.id}
                    task={task}
                    owner={bots.find((bot) => bot.id === task.ownerBotId)}
                    you={task.ownerBotId ? null : (state?.user.name ?? "You")}
                    blocker={blockerOf(task)}
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
                      // The task just before it by position: blocked tasks are shown first, so
                      // the one above it on screen may not be.
                      const before = column.tasks.reduce(
                        (best, other) =>
                          other.id !== id && other.position < task.position && other.position > best
                            ? other.position
                            : best,
                        task.position - 1,
                      );
                      void move(id, column.status, (before + task.position) / 2);
                    }}
                  />
                ))}
              </ol>
              {column.status === "done" && column.tasks.length > DONE_SHOWN && (
                <button
                  type="button"
                  onClick={() => setShowAllDone((value) => !value)}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-expanded={showAllDone}
                >
                  <ChevronDown
                    className={cn("size-3.5 transition-transform", showAllDone && "rotate-180")}
                  />
                  {showAllDone
                    ? "Show fewer"
                    : `Show ${column.tasks.length - DONE_SHOWN} more completed`}
                </button>
              )}
              {column.tasks.length === 0 &&
                (column.status !== "todo" || filter === "attention") && (
                  <p className="mx-0.5 rounded-[10px] border border-dashed border-foreground/10 px-2 py-5 text-center text-[12.5px] text-muted-foreground">
                    {filter !== "all"
                      ? "Nothing here."
                      : column.status === "doing"
                        ? "Nothing in progress."
                        : "Nothing finished yet."}
                  </p>
                )}
              {/* A quick-added task is yours, so it shows under All and Mine. */}
              {column.status === "todo" && filter !== "attention" && <QuickAdd onAdded={refresh} />}
            </section>
          ))}
        </div>
        {tasks.length === 0 && (
          <p className="text-center text-[13.5px] text-muted-foreground">
            Add what needs doing, or give a goal to your chief of staff and they&apos;ll fill the
            board.
          </p>
        )}
      </TabsContent>
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
    </Tabs>
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
        onSaved={() => void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() })}
      />
    </>
  );
}
