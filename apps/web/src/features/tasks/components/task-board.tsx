"use client";

import {
  boardColumns,
  DONE_SHOWN,
  dueLabel,
  dueState,
  filterCounts,
  TASK_BLOCKER_TEXT,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  taskBlocker,
  withTaskMoved,
  type TaskBlocker,
  type TaskFilter,
  type TaskPlacement,
} from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, CircleCheck, Plus } from "lucide-react";
import { useState, type DragEvent } from "react";
import { toast } from "sonner";
import { TeammateAvatar } from "@/components/teammate-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApprovals } from "@/features/approvals";
import { useAppState } from "@/features/app-shell";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import type { TeammateSummary, TaskView } from "@/lib/types";
import { isComputerOnline } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useTasks } from "../hooks";
import { TaskDialog } from "./task-dialog";

function Due({ dueOn, status }: { dueOn: string; status: TaskView["status"] }) {
  const state = dueState({ dueOn, status });
  const overdue = state === "overdue";
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-md text-[12px]",
        overdue
          ? "bg-attention/12 px-1.5 py-px text-attention-ink"
          : state === "today"
            ? "font-medium text-foreground"
            : "text-muted-foreground",
      )}
      title={overdue ? "Overdue" : undefined}
    >
      <CalendarDays className="size-3" />
      {dueLabel(dueOn)}
    </span>
  );
}

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
  owner: TeammateSummary | undefined;
  /** The owner's name, when the task is theirs: tasks without a teammate belong to them. */
  you: string | null;
  blocker: TaskBlocker | null;
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
            {TASK_BLOCKER_TEXT[blocker]}
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
              <TeammateAvatar name={owner.name} color={owner.color} emoji={owner.emoji} size="xs" />
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
          {task.dueOn && <Due dueOn={task.dueOn} status={task.status} />}
        </span>
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
        const result = await attempt(api.tasks.create({ title }));
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
        maxLength={TASK_TITLE_MAX}
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
  const [filter, setFilter] = useState<TaskFilter>("all");
  const { data: approvals } = useApprovals();
  const teammates = state?.teammates ?? [];
  /** A task whose chat waits on you says so on its card. */
  const online = !state || isComputerOnline(state);
  const facts = {
    approvalChatIds: new Set(
      (approvals ?? []).flatMap((a) => (a.status === "pending" && a.chatId ? [a.chatId] : [])),
    ),
    takeoverChatIds: new Set(
      (state?.takeoverRequests ?? []).flatMap((request) =>
        request.chatId ? [request.chatId] : [],
      ),
    ),
    online,
  };
  const blockerOf = (task: TaskView) => taskBlocker(task, facts);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });

  /**
   * Moves a task, showing it in place right away. The worker places it against the whole column,
   * and the board that comes back afterwards settles it, refused or not.
   */
  async function move(id: string, status: TaskView["status"], placement: TaskPlacement) {
    queryClient.setQueryData(
      orpc.tasks.list.queryKey(),
      (current) => current && (withTaskMoved(current, id, status, placement) ?? current),
    );
    const result = await attempt(api.tasks.move({ taskId: id, status, placement }));
    if (!result.ok) toast.error("Couldn't move it", { description: result.error });
    refresh();
  }

  if (isLoading || !tasks)
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {TASK_STATUSES.map((column) => (
          <Skeleton key={column} className="h-64 rounded-xl" />
        ))}
      </div>
    );

  const blockers = new Map(tasks.map((task) => [task.id, blockerOf(task)]));
  const cachedBlocker = (task: TaskView) => blockers.get(task.id) ?? null;
  const counts = filterCounts(tasks, cachedBlocker);
  // What waits on you leads its column, so it's seen first.
  const columns = boardColumns(tasks, cachedBlocker, filter);

  const dragId = (event: DragEvent) => event.dataTransfer.getData("text/task-id");

  return (
    <Tabs
      value={filter}
      onValueChange={(value) => setFilter(value as TaskFilter)}
      className="gap-4"
    >
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
              aria-label={TASK_STATUS_LABELS[column.status]}
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
                void move(id, column.status, { kind: "end" });
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
                {TASK_STATUS_LABELS[column.status]}
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
                    owner={teammates.find((teammate) => teammate.id === task.ownerTeammateId)}
                    you={task.ownerTeammateId ? null : (state?.user.name ?? "You")}
                    blocker={cachedBlocker(task)}
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
                      void move(id, column.status, { kind: "before", taskId: task.id });
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
          teammates={teammates}
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
        teammates={state?.teammates ?? []}
        open={open}
        onOpenChange={setOpen}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() })}
      />
    </>
  );
}
