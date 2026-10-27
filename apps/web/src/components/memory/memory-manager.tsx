"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, History, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type MemoryItem, type MemoryRevision } from "@open-bot/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  createMemoryItem,
  editMemoryItem,
  forgetMemoryItem,
  confirmMemoryItem,
  restoreMemoryItem,
} from "@/lib/actions";
import { getJson } from "@/lib/client/api";

function sourceLabel(item: MemoryItem) {
  if (item.source.type === "feedback") return "Your feedback";
  if (item.source.type === "import") return "Imported notes";
  if (item.source.type === "extraction") return "Suggested from a conversation";
  return item.source.type === "user" ? "Saved by you" : "Saved by a teammate";
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
  const scope = botId ? `botId=${encodeURIComponent(botId)}` : "";
  const url = `/api/memory?${scope}`;
  const {
    data: items,
    error,
    refetch,
  } = useQuery({
    queryKey: ["memory", botId, query],
    queryFn: () => getJson<MemoryItem[]>(`${url}&q=${encodeURIComponent(query)}`),
  });
  const revisions = useQuery({
    queryKey: ["memory", "history", history?.id, history?.revision],
    queryFn: () => getJson<MemoryRevision[]>(`/api/memory?history=${history!.id}`),
    enabled: !!history,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["memory"] });
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
    const result = await restoreMemoryItem({
      id: item.id,
      expectedRevision: item.revision,
      revision,
    });
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[13px] text-muted-foreground">
          {botId
            ? `${name}'s saved facts and lessons. Shared facts are managed in Settings.`
            : "Facts and preferences every teammate can use."}{" "}
          Suggestions become memory when you confirm them.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={`${url}&download=1`} download>
              <Download /> Export
            </a>
          </Button>
          <Button size="sm" onClick={() => edit(null)}>
            <Plus /> Add memory
          </Button>
        </div>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
        <Input
          aria-label="Search memories"
          placeholder="Search memories…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-9"
        />
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
        <div className="divide-y rounded-lg border">
          {items.map((item) => (
            <article key={item.id} data-testid="memory-item" className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="capitalize">{item.kind}</span>
                <span>·</span>
                <span>{sourceLabel(item)}</span>
                {item.state === "candidate" && (
                  <span className="rounded bg-waiting/10 px-2 py-0.5 text-waiting">Suggestion</span>
                )}
                {item.pinned && <span>Pinned</span>}
                {item.expiresAt && (
                  <span>
                    {new Date(item.expiresAt) <= new Date() ? "Expired" : "Expires"}{" "}
                    {new Date(item.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
                {item.content}
              </p>
              {item.key && <p className="font-mono text-xs text-muted-foreground">{item.key}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {item.state === "candidate" && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await confirmMemoryItem({
                          id: item.id,
                          expectedRevision: item.revision,
                        });
                        if (!result.ok) toast.error(result.error);
                        else {
                          await refresh();
                          toast("Memory confirmed");
                        }
                      })
                    }
                  >
                    <Check /> Confirm
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => edit(item)}>
                  <Pencil /> Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setHistory(item)}>
                  <History /> History
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setForget(item)}>
                  <Trash2 /> {item.state === "candidate" ? "Dismiss" : "Forget"}
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">
                  Revision {item.revision}
                </span>
              </div>
            </article>
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
                    ? await editMemoryItem({
                        ...input,
                        id: draft.item.id,
                        expectedRevision: draft.item.revision,
                      })
                    : await createMemoryItem(input);
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
                              void forgetMemoryItem({
                                id: result.data.id,
                                expectedRevision: result.data.revision,
                              }).then(async (undo) => {
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
                        const fresh = await getJson<MemoryItem[]>(url);
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
                  const result = await forgetMemoryItem({
                    id: forget.id,
                    expectedRevision: forget.revision,
                  });
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
              {pending ? <Loader2 className="animate-spin" /> : "Forget memory"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
