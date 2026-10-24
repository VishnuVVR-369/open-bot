"use client";

import { isRunActive } from "@open-bot/shared";
import {
  ArrowDown,
  Archive,
  Copy,
  RotateCcw,
  Monitor,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  Plus,
  Settings2,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { ComputerPanel } from "@/components/computer/computer-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DuplicateBotDialog } from "@/components/bots/duplicate-bot";
import { FileIcon } from "@/components/files/file-chip";
import { FilePreview } from "@/components/files/file-preview";
import { archiveChat, newDirectChat } from "@/lib/actions";
import { useAppState } from "@/lib/client/queries";
import { fileKind, fileUrl } from "@/lib/files";
import { botActivity } from "@/lib/status";
import type { BotSummary, MessageView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Composer, type ComposerHandle } from "./composer";
import { MessageText } from "./message-text";
import { RenameChatDialog } from "./rename-chat";
import { RunBlock } from "./run-block";
import { HelperScreen } from "./helper-screen";
import { useChat } from "./use-chat";

const PANEL_KEY = "open-bot:computer-panel";

/** A file you attached. Opens a preview when the app can show it, and downloads otherwise. */
function Attachment({ file }: { file: MessageView["attachments"][number] }) {
  const [open, setOpen] = useState(false);
  const className =
    "flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-muted";
  const content = (
    <>
      <FileIcon name={file.name} className="size-3.5 text-muted-foreground" />
      {file.name}
    </>
  );
  if (fileKind(file.name) === "other")
    return (
      <a href={fileUrl(file.path)} className={className}>
        {content}
      </a>
    );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {content}
      </button>
      <FilePreview path={file.path} open={open} onOpenChange={setOpen} />
    </>
  );
}

function UserMessage({ message }: { message: MessageView }) {
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="user-message">
      {message.redoOfRunId && (
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <RotateCcw className="size-3" />
          Asked to try again
        </span>
      )}
      {message.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {message.attachments.map((file) => (
            <Attachment key={file.path} file={file} />
          ))}
        </div>
      )}
      <div className="max-w-[85%] rounded-[18px] rounded-br-md bg-foreground px-3.5 py-2 text-[14.5px] leading-relaxed whitespace-pre-wrap text-background">
        <MessageText text={message.text} />
      </div>
    </div>
  );
}

const STARTERS = [
  "Open news.ycombinator.com and give me the 5 most interesting stories, with links.",
  "Every weekday at 9:00, check the weather in my city and send me a one-line summary.",
  "Remember that I prefer short answers with bullet points.",
];

function EmptyState({
  members,
  onPick,
  isGroup,
}: {
  members: BotSummary[];
  onPick: (text: string) => void;
  isGroup: boolean;
}) {
  const bot = members[0];
  return (
    <div className="m-auto flex w-full max-w-[560px] flex-col items-center gap-6 px-6 py-16 text-center">
      {isGroup ? (
        <div className="flex -space-x-2">
          {members.map((member) => (
            <BotAvatar
              key={member.id}
              name={member.name}
              color={member.color}
              emoji={member.emoji}
              size="lg"
              className="rounded-[14px] ring-4 ring-surface"
            />
          ))}
        </div>
      ) : (
        bot && <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xl" />
      )}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold">
          {isGroup ? "Start the conversation" : `Give ${bot?.name ?? "them"} something to do`}
        </h2>
        <p className="text-[14px] text-muted-foreground">
          {isGroup
            ? "Your message goes to the lead teammate, or to whoever you @mention. They pass work to each other."
            : `${bot?.name ?? "Your teammate"} works on the shared computer. Watch on the right, and take over whenever you want.`}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            onClick={() => onPick(starter)}
            className="rounded-xl border bg-card px-4 py-3 text-left text-[13.5px] text-foreground/85 transition-colors hover:border-foreground/25 hover:bg-muted/50"
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatView({ chatId }: { chatId: string }) {
  const router = useRouter();
  const { data: state } = useAppState();
  const { chat, members, entries, runs, loading, error, addOptimistic, helper } = useChat(chatId);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "duplicate" | null>(null);
  const allBots = state?.bots ?? members;

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
    };
  }, [runs, allBots]);

  // Stick to the bottom while new content streams in, unless you scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  });

  // A link to one run, like from a schedule's history, opens the chat at that run.
  const jumpedTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (loading) return;
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith("run-") || jumpedTo.current === hash) return;
    const target = document.getElementById(hash);
    if (!target) return;
    jumpedTo.current = hash;
    target.scrollIntoView({ block: "start" });
    onScroll();
    target.classList.add("run-highlight");
    setTimeout(() => target.classList.remove("run-highlight"), 2500);
  }, [loading, entries]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  }

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
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          {loading || !chat ? (
            <Skeleton className="h-6 w-40" />
          ) : (
            <>
              {isGroup ? (
                <span className="flex size-8 items-center justify-center rounded-[9px] bg-subtle text-muted-foreground">
                  <Users className="size-4" />
                </span>
              ) : (
                bot && (
                  <BotAvatar
                    name={bot.name}
                    color={bot.color}
                    emoji={bot.emoji}
                    size="sm"
                    activity={botActivity(bot)}
                  />
                )
              )}
              <div className="flex min-w-0 flex-col">
                <h1 className="truncate text-[15px] leading-tight font-semibold">{title}</h1>
                <span className="truncate text-[12.5px] leading-tight text-muted-foreground">
                  {helper
                    ? `${bot?.name ?? "A teammate"}'s helper in ${helper.swarmTitle}`
                    : isGroup
                      ? members.map((member) => member.name).join(", ")
                      : bot?.role}
                </span>
              </div>
              <span className="flex-1" />
              {!isGroup && bot && chat.kind === "direct" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="New chat"
                      onClick={async () => {
                        const result = await newDirectChat(bot.id);
                        if (result.ok) router.push(`/chats/${result.data.chatId}`);
                        else toast.error(result.error);
                      }}
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New chat with {bot.name}</TooltipContent>
                </Tooltip>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Chat options">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {bot && (
                    <DropdownMenuItem asChild>
                      <Link href={`/bots/${bot.id}`}>
                        <Settings2 />
                        {bot.name}&apos;s settings
                      </Link>
                    </DropdownMenuItem>
                  )}
                  {bot && (
                    <DropdownMenuItem onSelect={() => setDialog("duplicate")}>
                      <Copy />
                      Duplicate {bot.name}
                    </DropdownMenuItem>
                  )}
                  {chat.kind !== "scheduled" && (
                    <DropdownMenuItem onSelect={() => setDialog("rename")}>
                      <Pencil />
                      Rename
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={async () => {
                      const result = await archiveChat(chat.id);
                      if (!result.ok) {
                        toast.error(result.error);
                        return;
                      }
                      toast("Chat archived");
                      router.push("/");
                    }}
                  >
                    <Archive />
                    Archive chat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <RenameChatDialog
                chat={chat}
                open={dialog === "rename"}
                onOpenChange={(open) => setDialog(open ? "rename" : null)}
              />
              {bot && (
                <DuplicateBotDialog
                  bot={bot}
                  open={dialog === "duplicate"}
                  onOpenChange={(open) => setDialog(open ? "duplicate" : null)}
                />
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={panelOpen ? "Hide the computer" : "Show the computer"}
                    className="hidden xl:inline-flex"
                    onClick={togglePanel}
                  >
                    {panelOpen ? <PanelRightClose /> : <Monitor />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {panelOpen ? "Hide the computer" : "Show the computer"}
                </TooltipContent>
              </Tooltip>
              <Button
                variant="outline"
                size="sm"
                className="xl:hidden"
                onClick={() => setSheetOpen(true)}
              >
                <Monitor />
                Computer
              </Button>
            </>
          )}
        </header>

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
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-4 py-8 sm:px-6">
              {entries.map((entry) => {
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
              className="absolute -top-11 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-md"
              onClick={() =>
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                  behavior: "smooth",
                })
              }
            >
              <ArrowDown />
            </Button>
          )}
          <div className="mx-auto w-full max-w-[760px]">
            {chat && helper ? (
              <p className="mb-4 rounded-xl border bg-subtle/60 px-4 py-3 text-center text-[13px] text-muted-foreground">
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
                  onSent={(message) => {
                    addOptimistic(message);
                    setAtBottom(true);
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
          "hidden shrink-0 overflow-y-auto border-l bg-background p-5 xl:block",
          panelOpen ? "w-[clamp(440px,42%,760px)]" : "xl:hidden",
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
          className="w-full max-w-[640px] overflow-y-auto p-5 sm:max-w-[640px]"
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
