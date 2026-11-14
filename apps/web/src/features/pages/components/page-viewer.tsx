"use client";

import { pageQuestionText, parsePageAskMessage } from "@open-bot/domain";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  MessageSquare,
  MessageSquareText,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { TeammateAvatar } from "@/components/teammate-avatar";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { useAppState } from "@/features/app-shell";
import { usePage, usePageLink } from "../hooks";
import { api } from "@/lib/client/rpc";
import type { TeammateSummary, ChatSummary, PageDetail } from "@/lib/types";
import { chatHref, cn } from "@/lib/utils";
import { DeletePageDialog, downloadPage, openPageInTab, usePinPage } from "./page-actions";

interface Question {
  quote: string | null;
  section: string | null;
}

/** Where a question about the page goes: the chat it was made in, else its teammate's own chat. */
function questionTarget(
  page: PageDetail,
  teammate: TeammateSummary | undefined,
  chats: ChatSummary[],
): ChatSummary | null {
  if (!teammate) return null;
  const origin = chats.find((chat) => chat.id === page.chatId);
  if (origin && (origin.kind === "direct" || origin.kind === "group")) return origin;
  return chats.find((chat) => chat.id === teammate.directChatId) ?? null;
}

function AskPanel({
  page,
  version,
  teammate,
  chat,
  question,
  onClose,
}: {
  page: PageDetail;
  version: number;
  teammate: TeammateSummary;
  chat: ChatSummary;
  question: Question;
  onClose: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, startSending] = useTransition();
  const input = useRef<HTMLTextAreaElement>(null);
  const clientId = useRef(crypto.randomUUID());

  useEffect(() => {
    input.current?.focus();
  }, [question]);

  function send() {
    const draft = text.trim();
    if (!draft || sending) return;
    startSending(async () => {
      const result = await attempt(
        api.chats.send({
          clientId: clientId.current,
          chatId: chat.id,
          text: pageQuestionText({
            pageId: page.id,
            title: page.title,
            version,
            quote: question.quote,
            section: question.section,
            text: draft,
          }),
          attachments: [],
          mentions: chat.kind === "group" ? [teammate.id] : [],
        }),
      );
      if (!result.ok) {
        toast.error("Couldn't send", { description: result.error });
        return;
      }
      clientId.current = crypto.randomUUID();
      toast.success(`Sent to ${teammate.name}`, {
        description:
          "Their answer shows in the chat. If they change the page, the new version shows here.",
        action: { label: "Open chat", onClick: () => router.push(chatHref(chat.id)) },
      });
      onClose();
    });
  }

  return (
    <div
      role="dialog"
      aria-label={`Ask ${teammate.name} about this page`}
      className="absolute inset-x-3 bottom-3 z-10 flex flex-col gap-3 rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-[0_12px_40px_-8px_rgb(0_0_0/0.25)] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      data-testid="page-ask"
    >
      <div className="flex items-center gap-2">
        <TeammateAvatar
          name={teammate.name}
          color={teammate.color}
          emoji={teammate.emoji}
          size="xs"
        />
        <span className="flex-1 truncate text-[13.5px] font-medium">Ask {teammate.name}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {question.quote && (
        <figure className="flex flex-col gap-1 border-l-2 border-foreground/15 pl-3">
          {question.section && (
            <figcaption className="truncate text-[12.5px] font-medium text-muted-foreground">
              {question.section}
            </figcaption>
          )}
          <blockquote className="line-clamp-4 text-[13px] leading-normal text-muted-foreground">
            {question.quote}
          </blockquote>
        </figure>
      )}
      <Textarea
        ref={input}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
        rows={3}
        placeholder={
          question.quote
            ? "What would you like to know about this?"
            : "Ask a question or ask for a change"
        }
        className="max-h-40 min-h-[76px] resize-none text-[14px]"
        aria-label="Your question"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          Goes to {chat.kind === "group" ? chat.title : `your chat with ${teammate.name}`}
        </span>
        <Button size="sm" onClick={send} disabled={!text.trim() || sending}>
          <Send />
          Send
        </Button>
      </div>
    </div>
  );
}

function VersionMenu({
  page,
  shownId,
  onPick,
}: {
  page: PageDetail;
  shownId: string;
  onPick: (versionId: string) => void;
}) {
  const shown = page.versions.find((version) => version.id === shownId);
  if (!shown) return null;
  if (page.versions.length === 1) return <TimeAgo date={shown.createdAt} className="shrink-0" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="-mx-1 flex shrink-0 items-center gap-0.5 rounded-md px-1 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="page-versions"
      >
        Version {shown.number}
        {shown.id !== page.versionId && " (older)"}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(420px,70vh)] w-72 overflow-y-auto">
        <DropdownMenuLabel>Versions</DropdownMenuLabel>
        {page.versions.map((version) => (
          <DropdownMenuItem
            key={version.id}
            onSelect={() => onPick(version.id)}
            className="items-start py-2"
          >
            <Check className={cn("mt-0.5", version.id === shownId ? "opacity-100" : "opacity-0")} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                Version {version.number}
                {version.id === page.versionId && (
                  <span className="rounded bg-subtle px-1.5 text-[11px] font-medium text-muted-foreground">
                    Latest
                  </span>
                )}
              </span>
              {version.note && (
                <span className="line-clamp-2 text-[12.5px] text-muted-foreground">
                  {version.note}
                </span>
              )}
              <TimeAgo date={version.createdAt} className="text-[12px] text-muted-foreground" />
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One page, shown from its own origin, with its versions and a way to ask its teammate about it. */
export function PageViewer({ pageId, versionId }: { pageId: string; versionId: string | null }) {
  const router = useRouter();
  const { data: page, error } = usePage(pageId);
  const { data: state } = useAppState();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const pin = usePinPage();

  // The version on screen, and the newest one you know about: a newer one offers itself.
  const [shownId, setShownId] = useState<string | null>(null);
  const [knownLatest, setKnownLatest] = useState<string | null>(null);
  useEffect(() => {
    if (!page || shownId) return;
    const asked = versionId && page.versions.some((version) => version.id === versionId);
    setShownId(asked ? versionId : page.versionId);
    setKnownLatest(page.versionId);
  }, [page, shownId, versionId]);

  const shown = page?.versions.find((version) => version.id === shownId) ?? null;
  const {
    data: link,
    error: linkError,
    refetch: refetchLink,
  } = usePageLink(shown?.id ?? null, theme, true);
  const [loaded, setLoaded] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);

  const teammate = state?.teammates.find((candidate) => candidate.id === page?.teammateId);
  const chat = page ? questionTarget(page, teammate, state?.chats ?? []) : null;
  const canAsk = Boolean(teammate && chat);

  // "Ask about this" from the page. Only the frame we made may ask, and only to prefill.
  useEffect(() => {
    if (!canAsk) return;
    function onMessage(event: MessageEvent) {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = parsePageAskMessage(event.data);
      if (message) setQuestion({ quote: message.quote, section: message.section });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [canAsk]);

  function pick(id: string) {
    if (!page) return;
    setShownId(id);
    setKnownLatest(page.versionId);
    setQuestion(null);
    router.replace(id === page.versionId ? `/pages/${page.id}` : `/pages/${page.id}?v=${id}`, {
      scroll: false,
    });
  }

  if (error) {
    const gone = /deleted/.test(error.message);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText className="size-6 text-muted-foreground" />
        <p className="font-medium">{gone ? "This page was deleted" : "Couldn't load this page"}</p>
        <p className="text-sm text-muted-foreground">
          {gone ? "Its teammate can make it again if you ask." : error.message}
        </p>
        <Button variant="outline" className="mt-2" asChild>
          <Link href="/pages">All pages</Link>
        </Button>
      </div>
    );
  }

  const newer =
    page && shown && page.versionId !== shown.id && page.versionId !== knownLatest
      ? page.versions[0]
      : null;
  const frameReady = link && loaded === link.url;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:gap-3 sm:px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" asChild>
              <Link href="/pages" aria-label="All pages">
                <ArrowLeft />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>All pages</TooltipContent>
        </Tooltip>
        {!page || !shown ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-col">
              <h1
                className="truncate text-[15px] leading-tight font-semibold"
                data-testid="page-title"
              >
                {shown.title}
              </h1>
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-muted-foreground">
                {page.pinned && <Pin className="size-3 shrink-0" aria-label="Pinned" />}
                <span className="truncate">{teammate?.name ?? "Former teammate"}</span>
                <span aria-hidden>·</span>
                <VersionMenu page={page} shownId={shown.id} onPick={pick} />
              </span>
            </div>
            {canAsk && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 max-sm:size-8 max-sm:p-0"
                onClick={() => setQuestion({ quote: null, section: null })}
                aria-label={`Ask ${teammate!.name} about this page`}
                data-testid="page-ask-open"
              >
                <MessageSquare />
                <span className="max-sm:hidden">Ask {teammate!.name}</span>
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="max-sm:hidden"
                  aria-label="Open in a new tab"
                  onClick={() => void openPageInTab(shown.id, theme)}
                >
                  <ExternalLink />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in a new tab</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Page options">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => void pin(page.id, !page.pinned)}>
                  {page.pinned ? <PinOff /> : <Pin />}
                  {page.pinned ? "Unpin" : "Pin to top"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="sm:hidden"
                  onSelect={() => void openPageInTab(shown.id, theme)}
                >
                  <ExternalLink />
                  Open in a new tab
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => downloadPage(shown.id)}>
                  <Download />
                  Download
                </DropdownMenuItem>
                {chat && (
                  <DropdownMenuItem asChild>
                    <Link href={chatHref(chat.id, shown.runId)}>
                      <MessageSquareText />
                      Go to the chat
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DeletePageDialog
              page={page}
              open={deleting}
              onOpenChange={setDeleting}
              onDeleted={() => router.push("/pages")}
            />
          </>
        )}
      </header>

      <div className="relative min-h-0 flex-1 bg-background">
        {newer && (
          <div className="absolute inset-x-0 top-3 z-10 flex justify-center px-3">
            <div
              className="flex items-center gap-2 rounded-full border bg-popover py-1 pr-1 pl-3.5 text-[13px] shadow-md"
              data-testid="page-newer"
            >
              <span>Version {newer.number} is ready</span>
              <Button size="xs" className="rounded-full" onClick={() => pick(newer.id)}>
                Show it
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                aria-label="Dismiss"
                onClick={() => setKnownLatest(page!.versionId)}
              >
                <X />
              </Button>
            </div>
          </div>
        )}
        {linkError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="font-medium">Couldn&apos;t open this version</p>
            <p className="text-sm text-muted-foreground">{linkError.message}</p>
            <Button variant="outline" className="mt-2" onClick={() => void refetchLink()}>
              <RefreshCw />
              Try again
            </Button>
          </div>
        ) : (
          link && (
            <iframe
              key={link.url}
              ref={frame}
              src={link.url}
              title={shown?.title ?? "Page"}
              // The page's own CSP sandboxes it too; this keeps it sandboxed even if that's lost.
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              allow="clipboard-write; fullscreen"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(link.url)}
              className={cn(
                "absolute inset-0 size-full border-0 transition-opacity duration-200",
                frameReady ? "opacity-100" : "opacity-0",
              )}
              data-testid="page-frame"
            />
          )
        )}
        {!frameReady && !linkError && (
          <div className="pointer-events-none absolute inset-0 mx-auto flex max-w-[760px] flex-col gap-4 px-6 pt-12">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="mt-4 h-48 w-full rounded-xl" />
          </div>
        )}
        {question && page && shown && teammate && chat && (
          <AskPanel
            page={page}
            version={shown.number}
            teammate={teammate}
            chat={chat}
            question={question}
            onClose={() => setQuestion(null)}
          />
        )}
      </div>
    </div>
  );
}
