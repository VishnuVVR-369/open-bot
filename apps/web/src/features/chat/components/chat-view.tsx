"use client";

import { isRunActive } from "@open-bot/domain";
import { ArrowDown, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ComputerPanel, useComputer } from "@/features/computer";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppState } from "@/features/app-shell";
import { chatStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Composer, type ComposerHandle } from "./composer";
import { RunBlock } from "./run-block";
import { HelperScreen } from "./helper-screen";
import { useChat } from "../use-chat";
import { UserMessage } from "./user-message";
import { EmptyState } from "./empty-state";
import { ChatHeader } from "./chat-header";
import { useChatScroll } from "../use-chat-scroll";
import { useMarkRead } from "../use-mark-read";

const PANEL_KEY = "open-bot:computer-panel";

export function ChatView({ chatId }: { chatId: string }) {
  const { data: state } = useAppState();
  const { chat, members, entries, runs, loading, error, addOptimistic, helper } = useChat(chatId);
  const composer = useRef<ComposerHandle>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const allBots = state?.bots ?? members;
  const { online, state: computerState } = useComputer();
  // Known offline, not just unknown yet: the panel collapses to a chip in the header.
  const offline = Boolean(computerState) && !online;

  useEffect(() => {
    setPanelOpen(localStorage.getItem(PANEL_KEY) !== "closed");
  }, []);

  // A run is superseded once the same bot has run again after it in this chat.
  const supersededRuns = useMemo(() => {
    const superseded = new Map<string, boolean>();
    const seen = new Set<string>();
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "run") continue;
      superseded.set(entry.run.id, seen.has(entry.run.botId));
      seen.add(entry.run.botId);
    }
    return superseded;
  }, [entries]);
  // The last reply in the chat keeps its actions in view.
  const lastRunIndex = entries.findLastIndex((entry) => entry.type === "run");

  const steered = useMemo(() => {
    const ids = new Set<string>();
    for (const run of Object.values(runs)) {
      for (const item of run.timeline.items)
        if (item.kind === "user_message") ids.add(item.messageId);
    }
    return ids;
  }, [runs]);

  const activeRun = useMemo(() => {
    const active = Object.values(runs)
      .filter((run) => isRunActive(run.timeline.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!active) return null;
    return {
      id: active.id,
      botName: allBots.find((bot) => bot.id === active.botId)?.name ?? "Your teammate",
      status: active.timeline.status,
      waitingFor: active.timeline.waitingFor ?? null,
    };
  }, [runs, allBots]);

  useMarkRead(chatId, runs, loading, error);
  const { scroller, onScroll, atBottom, scrolled, stickToBottom, scrollToLatest } = useChatScroll(
    loading,
    entries,
  );

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="font-medium">This chat isn&apos;t available.</p>
        <p className="text-sm text-muted-foreground">It may have been archived.</p>
        <Button variant="outline" className="mt-2" asChild>
          <Link href="/">Go home</Link>
        </Button>
      </div>
    );
  }

  const isGroup = chat?.kind === "group";
  const bot = !isGroup ? members[0] : undefined;
  // This chat's state, not the teammate's: what they wait for elsewhere is a link to there. While
  // the computer's state is still loading, nothing is shown as paused.
  const liveBot = bot && (allBots.find((entry) => entry.id === bot.id) ?? bot);
  const status =
    liveBot && !isGroup && !helper
      ? chatStatus({
          bot: liveBot,
          chatId,
          computerOnline: !offline,
          chatById: (id) => state?.chats.find((entry) => entry.id === id),
        })
      : null;
  // From the chat list, which every change refreshes: another device may have picked a new main chat.
  const isMain = state?.chats.find((entry) => entry.id === chatId)?.main ?? chat?.main ?? false;
  const title = chat
    ? chat.kind === "scheduled"
      ? `${bot?.name ?? ""} · Scheduled`
      : chat.kind === "inbox"
        ? `${bot?.name ?? ""} · Email`
        : chat.title
    : "";

  function togglePanel() {
    setPanelOpen((open) => {
      localStorage.setItem(PANEL_KEY, open ? "closed" : "open");
      return !open;
    });
  }

  return (
    <div className="flex h-full min-h-0">
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length) composer.current?.addFiles(event.dataTransfer.files);
        }}
      >
        {/* On a phone this is the only bar: it carries the menu button the app bar would have. */}
        <ChatHeader
          chat={chat}
          loading={loading}
          members={members}
          teammate={bot}
          helper={helper}
          title={title}
          status={status}
          isMain={isMain}
          scrolled={scrolled}
          offline={offline}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          onOpenComputer={() => setSheetOpen(true)}
        />

        <div
          ref={scroller}
          onScroll={onScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          data-testid="timeline"
        >
          {loading ? (
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-8">
              <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
              <div className="flex gap-3">
                <Skeleton className="size-9 rounded-[10px]" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-16 w-full" />
                </div>
              </div>
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              members={members}
              isGroup={isGroup}
              onPick={(text) => composer.current?.setDraft(text)}
            />
          ) : (
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-4 py-8 sm:px-6">
              {entries.map((entry, index) => {
                if (entry.type === "message") {
                  if (entry.message.steeredRunId || steered.has(entry.message.id)) return null;
                  return <UserMessage key={entry.message.id} message={entry.message} />;
                }
                const run = runs[entry.run.id] ?? entry.run;
                return (
                  <RunBlock
                    key={run.id}
                    run={run}
                    chatId={chatId}
                    superseded={supersededRuns.get(run.id) ?? false}
                    latest={index === lastRunIndex}
                    bot={allBots.find((b) => b.id === run.botId)}
                    bots={allBots}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="relative shrink-0 px-4 pb-4 sm:px-6">
          {!atBottom && (
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Scroll to the latest"
              className="absolute -top-11 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-float"
              onClick={scrollToLatest}
            >
              <ArrowDown />
            </Button>
          )}
          <div className="mx-auto w-full max-w-[760px]">
            {chat && helper ? (
              <p className="mb-4 rounded-xl bg-subtle px-4 py-3 text-center text-[13px] text-muted-foreground">
                A helper works on its part alone. Its result goes back to{" "}
                {bot?.name ?? "its teammate"},{" "}
                <Link
                  href={`/chats/${helper.swarmChatId}#run-${helper.swarmRunId}`}
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  where you can follow the swarm
                </Link>
                .
              </p>
            ) : (
              chat && (
                <Composer
                  ref={composer}
                  chat={chat}
                  members={members}
                  activeRun={activeRun}
                  computerOnline={!offline}
                  onSent={(message) => {
                    addOptimistic(message);
                    stickToBottom();
                  }}
                />
              )
            )}
          </div>
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-3 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-foreground/30 bg-surface/90 text-[14px] font-medium">
            <Upload className="size-5" />
            Drop files to attach them
          </div>
        )}
      </div>

      <aside
        className={cn(
          "hidden w-[clamp(440px,42%,760px)] shrink-0 overflow-y-auto border-l border-border/70 bg-[color-mix(in_oklab,var(--background)_45%,var(--surface))] p-5 xl:block",
          // The full panel is for a live screen. Offline, the header's chip stands in for it.
          (!panelOpen || (offline && !helper)) && "xl:hidden",
        )}
      >
        {helper ? (
          <HelperScreen helper={helper} />
        ) : (
          <ComputerPanel botIds={members.map((member) => member.id)} loading={loading} />
        )}
      </aside>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className={cn(
            "w-full overflow-y-auto p-5",
            offline && !helper
              ? "max-w-[420px] sm:max-w-[420px]"
              : "max-w-[640px] sm:max-w-[640px]",
          )}
        >
          <SheetTitle className="mb-4">Computer</SheetTitle>
          {sheetOpen &&
            (helper ? (
              <HelperScreen helper={helper} />
            ) : (
              <ComputerPanel botIds={members.map((member) => member.id)} loading={loading} />
            ))}
        </SheetContent>
      </Sheet>
    </div>
  );
}
