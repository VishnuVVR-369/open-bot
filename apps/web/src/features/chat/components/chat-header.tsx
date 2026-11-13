"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowRight,
  CloudOff,
  Copy,
  Menu,
  Monitor,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  Plus,
  Settings2,
  Star,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useOpenMobileMenu } from "@/components/app/mobile-menu";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DuplicateBotDialog } from "@/features/teammates";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import type { chatStatus } from "@/lib/status";
import type { BotSummary, ChatData, ChatSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RenameChatDialog } from "./rename-chat";

/**
 * The chat's bar: who it's with and what they're doing, the chat's menu and the computer's
 * button. On a phone it is the only bar, so it carries the app's menu button too.
 */
export function ChatHeader({
  chat,
  loading,
  members,
  teammate,
  helper,
  title,
  status,
  isMain,
  scrolled,
  offline,
  panelOpen,
  onTogglePanel,
  onOpenComputer,
}: {
  chat: ChatSummary | null;
  loading: boolean;
  members: BotSummary[];
  /** The teammate of a chat that isn't a group. */
  teammate: BotSummary | undefined;
  helper: ChatData["helper"];
  title: string;
  status: ReturnType<typeof chatStatus> | null;
  isMain: boolean;
  scrolled: boolean;
  offline: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenComputer: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const openMenu = useOpenMobileMenu();
  const [dialog, setDialog] = useState<"rename" | "duplicate" | null>(null);
  const isGroup = chat?.kind === "group";
  const elsewhere = status?.elsewhere ?? null;

  async function startNewChat(botId: string) {
    const result = await attempt(api.chats.newDirect({ botId }));
    if (result.ok) router.push(`/chats/${result.data.chatId}`);
    else toast.error(result.error);
  }

  return (
    <header
      className={cn(
        "relative z-10 flex h-14 shrink-0 items-center gap-2 border-b pr-2 pl-1.5 transition-[border-color,box-shadow] duration-200 sm:gap-3 sm:px-4 lg:pl-4 [&_button[data-variant=ghost]]:text-muted-foreground [&_button[data-variant=ghost]:hover]:text-foreground",
        scrolled
          ? "border-border/70 shadow-[0_6px_14px_-10px_rgb(0_0_0/0.18)] dark:shadow-[0_6px_14px_-10px_rgb(0_0_0/0.6)]"
          : "border-transparent",
      )}
    >
      {openMenu && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          className="shrink-0 lg:hidden"
          onClick={openMenu}
        >
          <Menu />
        </Button>
      )}
      {loading || !chat ? (
        <Skeleton className="h-6 w-40" />
      ) : (
        <>
          {isGroup ? (
            <span className="flex size-8 items-center justify-center rounded-[9px] bg-subtle text-muted-foreground">
              <Users className="size-4" />
            </span>
          ) : (
            teammate && (
              <BotAvatar
                name={teammate.name}
                color={teammate.color}
                emoji={teammate.emoji}
                size="sm"
                activity={status?.activity}
              />
            )
          )}
          <div
            className="flex min-w-0 flex-col"
            title={teammate && !isGroup ? `${teammate.name}, ${teammate.role}` : undefined}
          >
            <h1 className="truncate text-[15px] leading-tight font-semibold">{title}</h1>
            <span
              className="truncate text-[12.5px] leading-tight text-muted-foreground"
              data-testid="chat-status"
            >
              {helper ? (
                `${teammate?.name ?? "A teammate"}'s helper in ${helper.swarmTitle}`
              ) : isGroup ? (
                members.map((member) => member.name).join(", ")
              ) : teammate && status ? (
                <>
                  {/* Titled after its topic, so say who it's with. */}
                  {chat.kind === "direct" && chat.title !== teammate.name && `${teammate.name} · `}
                  <span
                    className={cn(
                      status.needsYou && "text-attention-ink",
                      elsewhere && "max-sm:hidden",
                    )}
                  >
                    {status.label}
                  </span>
                  {/* On a phone there's no room for the chip: the line links there instead. */}
                  {elsewhere && (
                    <Link
                      href={`/chats/${elsewhere.chatId}`}
                      className="text-attention-ink underline-offset-2 hover:underline sm:hidden"
                      aria-label={elsewhere.label}
                    >
                      {elsewhere.short} →
                    </Link>
                  )}
                </>
              ) : null}
            </span>
          </div>
          {elsewhere && (
            // What the teammate waits for in another chat, and a way there.
            <Link
              href={`/chats/${elsewhere.chatId}`}
              className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full bg-attention/[0.1] px-2.5 text-[12.5px] font-medium text-attention-ink transition-colors hover:bg-attention/[0.16] max-sm:hidden"
              data-testid="chat-elsewhere"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-attention" />
              <span className="truncate">{elsewhere.label}</span>
              <ArrowRight className="size-3.5 shrink-0" />
            </Link>
          )}
          <span className="flex-1" />
          {!isGroup && teammate && chat.kind === "direct" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New chat"
                  className="max-sm:hidden"
                  onClick={() => void startNewChat(teammate.id)}
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New chat with {teammate.name}</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Chat options">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* On a phone, New chat lives here so the title keeps its room. */}
              {!isGroup && teammate && chat.kind === "direct" && (
                <DropdownMenuItem
                  className="sm:hidden"
                  onSelect={() => void startNewChat(teammate.id)}
                >
                  <Plus />
                  New chat with {teammate.name}
                </DropdownMenuItem>
              )}
              {teammate && (
                <DropdownMenuItem asChild>
                  <Link href={`/bots/${teammate.id}`}>
                    <Settings2 />
                    {teammate.name}&apos;s settings
                  </Link>
                </DropdownMenuItem>
              )}
              {teammate && (
                <DropdownMenuItem onSelect={() => setDialog("duplicate")}>
                  <Copy />
                  Duplicate {teammate.name}
                </DropdownMenuItem>
              )}
              {chat.kind === "direct" && !isMain && (
                <DropdownMenuItem
                  onSelect={async () => {
                    const result = await attempt(api.chats.makeMain({ chatId: chat.id }));
                    if (!result.ok) {
                      toast.error(result.error);
                      return;
                    }
                    await queryClient.invalidateQueries({
                      queryKey: orpc.chats.get.key({ input: { chatId: chat.id } }),
                    });
                    toast("This is now the main chat");
                  }}
                >
                  <Star />
                  Make this the main chat
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
                  const result = await attempt(api.chats.archive({ chatId: chat.id }));
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
          {teammate && (
            <DuplicateBotDialog
              bot={teammate}
              open={dialog === "duplicate"}
              onOpenChange={(open) => setDialog(open ? "duplicate" : null)}
            />
          )}
          {offline && !helper ? (
            // An offline computer has no screen to watch: a chip says so and opens the details.
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenComputer}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-subtle px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  data-testid="computer-offline-chip"
                >
                  <CloudOff className="size-3.5" />
                  <span className="max-sm:hidden">Computer offline</span>
                  <span className="sm:hidden">Offline</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                Work that needs the computer waits until it&apos;s back
              </TooltipContent>
            </Tooltip>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={panelOpen ? "Hide the computer" : "Show the computer"}
                    className="hidden xl:inline-flex"
                    onClick={onTogglePanel}
                  >
                    {panelOpen ? <PanelRightClose /> : <Monitor />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {panelOpen ? "Hide the computer" : "Show the computer"}
                </TooltipContent>
              </Tooltip>
              {/* On a phone the label would squeeze the chat title, so only the icon shows. */}
              <Button
                variant="outline"
                size="sm"
                aria-label="Computer"
                className="max-sm:size-9 max-sm:border-transparent max-sm:bg-transparent max-sm:px-0 max-sm:text-muted-foreground max-sm:shadow-none xl:hidden"
                onClick={onOpenComputer}
              >
                <Monitor />
                <span className="max-sm:sr-only">Computer</span>
              </Button>
            </>
          )}
        </>
      )}
    </header>
  );
}
