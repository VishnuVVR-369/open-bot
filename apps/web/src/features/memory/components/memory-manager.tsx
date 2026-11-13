"use client";

import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Check,
  Download,
  Ellipsis,
  History,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type MemoryItem } from "@open-bot/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { useMemories, useMemoryHistory } from "../hooks";
import { useAppState } from "@/features/app-shell";

/** Who saved a memory, by name when a teammate did. */
function sourceLabel(item: MemoryItem, teammate: string | null) {
  if (item.source.type === "feedback") return "From your feedback";
  if (item.source.type === "import") return "Imported";
  if (item.source.type === "user") return "Saved by you";
  const verb =
    item.state === "candidate" || item.source.type === "extraction" ? "Suggested" : "Saved";
  if (teammate) return `${verb} by ${teammate}`;
  return item.source.type === "extraction"
    ? `${verb} from a conversation`
    : `${verb} by a teammate`;
}

const KIND_LABEL: Record<MemoryItem["kind"], string> = {
  fact: "Fact",
  preference: "Preference",
  lesson: "Lesson",
  note: "Note",
};

function MemoryRow({
  item,
  savedBy,
  busy,
  onConfirm,
  onEdit,
  onHistory,
  onForget,
}: {
  item: MemoryItem;
  savedBy: string | null;
  busy: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onForget: () => void;
}) {
  const suggestion = item.state === "candidate";
  const expired = item.expiresAt !== null && new Date(item.expiresAt) <= new Date();
  return (
    <article
      data-testid="memory-item"
      className="group/memory flex items-start gap-3 py-3.5 pr-2.5 pl-4 transition-colors hover:bg-subtle/40"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
          {suggestion && (
            <span className="mr-0.5 rounded-full bg-foreground/[0.07] px-2 py-px font-medium text-foreground">
              Suggestion
            </span>
          )}
          <span>{KIND_LABEL[item.kind]}</span>
          <span aria-hidden>·</span>
          <span>{sourceLabel(item, savedBy)}</span>
          {item.pinned && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <Pin className="size-3" />
                Pinned
              </span>
            </>
          )}
          {item.expiresAt && (
            <>
              <span aria-hidden>·</span>
              <span>
                {expired ? "Expired" : "Expires"} {format(new Date(item.expiresAt), "MMM d")}
              </span>
            </>
          )}
          {item.revision > 1 && (
            <>
              <span aria-hidden>·</span>
              <span>Revision {item.revision}</span>
            </>
          )}
        </div>
        <p className="text-[14px] leading-relaxed break-words whitespace-pre-wrap">
          {item.content}
        </p>
        {suggestion && (
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={onConfirm}>
              <Check /> Confirm
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onForget}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            className="text-muted-foreground opacity-0 group-focus-within/memory:opacity-100 group-hover/memory:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onHistory}>
            <History /> History
          </DropdownMenuItem>
          {!suggestion && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onForget}>
                <Trash2 /> Forget
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}

export function MemoryManager({ botId, name }: { botId: string | null; name: string }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{
    item: MemoryItem | null;
    content: string;
    kind: MemoryItem["kind"];
    key: string;
    pinned: boolean;
    expiresAt: string;
  } | null>(null);
  const [history, setHistory] = useState<MemoryItem | null>(null);
  const [forget, setForget] = useState<MemoryItem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const downloadUrl = `/api/memory${botId ? `?botId=${encodeURIComponent(botId)}` : ""}`;
  const { data: items, error, refetch } = useMemories(botId, query);
  // Saving a memory refreshes everything under `memory`, its history too.
  const revisions = useMemoryHistory(history?.id ?? null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.memory.key() });
  const { data: state } = useAppState();
  const savedBy = (item: MemoryItem) =>
    state?.bots.find((bot) => bot.id === item.source.botId)?.name ?? null;
  function edit(item: MemoryItem | null) {
    setProblem(null);
    setDraft({
      item,
      content: item?.content ?? "",
      kind: item?.kind ?? "fact",
      key: item?.key ?? "",
      pinned: item?.pinned ?? false,
      expiresAt: item?.expiresAt?.slice(0, 16) ?? "",
    });
  }
  async function restore(item: MemoryItem, revision: number, openHistory = true) {
    const result = await attempt(
      api.memory.restore({ id: item.id, expectedRevision: item.revision, revision }),
    );
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    if (openHistory) setHistory(result.data);
    await refresh();
    toast("Memory restored");
  }
  return (
    <section className="flex flex-col gap-4" data-testid="memory-manager">
      {botId && (
        <p className="max-w-xl text-[13.5px] text-muted-foreground">
          {name}&apos;s saved facts and lessons. Shared facts are managed in Settings. Suggestions
          become memory when you confirm them.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 basis-full sm:basis-0">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search memories"
            placeholder="Search memories…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 pl-9"
          />
        </div>
        <Button variant="outline" size="lg" asChild>
          <a href={downloadUrl} download>
            <Download /> Export
          </a>
        </Button>
        <Button size="lg" onClick={() => edit(null)}>
          <Plus /> Add memory
        </Button>
      </div>
      {error ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          Couldn&apos;t load memory.
          <Button variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : !items ? (
        <Skeleton className="h-32 w-full" />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {query
            ? "No memories match that search."
            : "No saved memories yet. Add a fact, or ask your teammate to remember something."}
        </p>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl bg-card shadow-raised">
          {items.map((item) => (
            <MemoryRow
              key={item.id}
              item={item}
              savedBy={savedBy(item)}
              busy={pending}
              onConfirm={() =>
                startTransition(async () => {
                  const result = await attempt(
                    api.memory.confirm({ id: item.id, expectedRevision: item.revision }),
                  );
                  if (!result.ok) toast.error(result.error);
                  else {
                    await refresh();
                    toast("Memory confirmed");
                  }
                })
              }
              onEdit={() => edit(item)}
              onHistory={() => setHistory(item)}
              onForget={() => setForget(item)}
            />
          ))}
        </div>
      )}
      {items?.length === 200 && (
        <p className="text-xs text-muted-foreground">
          Showing the newest 200 memories. Search to find older ones.
        </p>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.item ? "Edit memory" : "Add memory"}</DialogTitle>
            <DialogDescription>
              {botId
                ? `Only ${name} receives this memory automatically.`
                : "Every teammate can use this memory."}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                startTransition(async () => {
                  const input = {
                    botId,
                    content: draft.content,
                    kind: draft.kind,
                    key: draft.key.trim() || null,
                    pinned: draft.pinned,
                    expiresAt: draft.expiresAt
                      ? new Date(draft.expiresAt + "Z").toISOString()
                      : null,
                  };
                  const result = draft.item
                    ? await attempt(
                        api.memory.update({
                          ...input,
                          id: draft.item.id,
                          expectedRevision: draft.item.revision,
                        }),
                      )
                    : await attempt(api.memory.create(input));
                  if (!result.ok) {
                    setProblem(result.error);
                    await refresh();
                    return;
                  }
                  const previous = draft.item;
                  setDraft(null);
                  await refresh();
                  const created =
                    "saveOutcome" in result.data && result.data.saveOutcome === "created";
                  const unchanged =
                    "saveOutcome" in result.data && result.data.saveOutcome === "unchanged";
                  toast(unchanged ? "Memory already saved" : "Memory saved", {
                    action: previous
                      ? {
                          label: "Undo",
                          onClick: () => void restore(result.data, previous.revision, false),
                        }
                      : created
                        ? {
                            label: "Undo",
                            onClick: () => {
                              void attempt(
                                api.memory.forget({
                                  id: result.data.id,
                                  expectedRevision: result.data.revision,
                                }),
                              ).then(async (undo) => {
                                if (!undo.ok) toast.error(undo.error);
                                else await refresh();
                              });
                            },
                          }
                        : undefined,
                  });
                });
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="memory-content">Memory</Label>
                <Textarea
                  id="memory-content"
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  required
                  minLength={3}
                  maxLength={8000}
                  className="min-h-32"
                  placeholder="One durable fact or preference…"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="memory-kind">Type</Label>
                  <select
                    id="memory-kind"
                    value={draft.kind}
                    onChange={(event) =>
                      setDraft({ ...draft, kind: event.target.value as MemoryItem["kind"] })
                    }
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {["fact", "preference", "lesson", "note"].map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="memory-expiry">Expires at (UTC, optional)</Label>
                  <Input
                    id="memory-expiry"
                    type="datetime-local"
                    value={draft.expiresAt}
                    onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="memory-key">Topic key (optional)</Label>
                <Input
                  id="memory-key"
                  value={draft.key}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  maxLength={120}
                  placeholder="career.work_arrangement"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.pinned}
                  onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
                />{" "}
                Prioritize in task context
              </label>
              {problem && (
                <div role="alert" className="text-sm text-destructive">
                  {problem}
                  {draft.item && (
                    <Button
                      type="button"
                      variant="link"
                      onClick={async () => {
                        const fresh = await api.memory.list({ botId, query: "" });
                        const item = fresh.find((i) => i.id === draft.item?.id);
                        if (item) edit(item);
                        else setProblem("This memory was forgotten. Close this editor.");
                      }}
                    >
                      Reload saved version
                    </Button>
                  )}
                </div>
              )}
              <Button disabled={pending || draft.content.trim().length < 3} type="submit">
                {pending && <Loader2 className="animate-spin" />} Save memory
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={history !== null}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      >
        <DialogContent className="max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Memory history</DialogTitle>
            <DialogDescription>
              Restore creates a new revision. Forgotten memory has no retained history.
            </DialogDescription>
          </DialogHeader>
          {revisions.error ? (
            <p role="alert">Couldn&apos;t load history.</p>
          ) : !revisions.data ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="flex flex-col gap-5">
              {revisions.data.map((revision) => (
                <div key={revision.revision} className="flex flex-col gap-2 border-b pb-4">
                  <div className="text-xs text-muted-foreground">
                    Revision {revision.revision} · {new Date(revision.createdAt).toLocaleString()}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{revision.content}</p>
                  {revision.source.runId && revision.source.chatId && (
                    <a
                      className="text-xs underline underline-offset-4"
                      href={`/chats/${revision.source.chatId}#run-${revision.source.runId}`}
                    >
                      See source conversation
                    </a>
                  )}
                  {history && revision.revision !== history.revision && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => startTransition(() => restore(history, revision.revision))}
                    >
                      Restore revision {revision.revision}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={forget !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setForget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {forget?.state === "candidate" ? "Dismiss this suggestion?" : "Forget this memory?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Saved versions and search results will be removed. Original conversations remain.
              Running tasks will stop so they can restart with current facts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                if (!forget) return;
                startTransition(async () => {
                  const result = await attempt(
                    api.memory.forget({ id: forget.id, expectedRevision: forget.revision }),
                  );
                  if (!result.ok) {
                    toast.error(result.error);
                    await refresh();
                    return;
                  }
                  setForget(null);
                  await refresh();
                  toast("Memory forgotten");
                });
              }}
            >
              {pending ? (
                <Loader2 className="animate-spin" />
              ) : forget?.state === "candidate" ? (
                "Dismiss suggestion"
              ) : (
                "Forget memory"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
