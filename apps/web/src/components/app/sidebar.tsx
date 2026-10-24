"use client";

import {
  FolderClosed,
  KeyRound,
  House,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  ListTodo,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { BotAvatar } from "@/components/bot-avatar";
import { Wordmark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { useAppState } from "@/lib/client/queries";
import { botActivity, botStatusText } from "@/lib/status";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useCommandMenu } from "./command-menu";
import { NewGroupDialog } from "./new-group-dialog";
import { NotificationsButton } from "./notifications";

function NavItem({
  href,
  icon: Icon,
  label,
  badge,
  active,
  onNavigate,
}: {
  href: string;
  icon: typeof House;
  label: string;
  badge?: number;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13.5px] text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
        active && "bg-sidebar-accent font-medium text-sidebar-foreground",
      )}
    >
      <Icon className="size-4 shrink-0 opacity-80" strokeWidth={1.8} />
      <span className="flex-1 truncate">{label}</span>
      {badge ? (
        <span className="min-w-5 rounded-full bg-waiting px-1.5 text-center text-[11px] leading-5 font-semibold text-white tabular-nums">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/** Opens ⌘K search, styled like the nav items around it. */
function SearchItem({ onNavigate }: { onNavigate?: () => void }) {
  const { open } = useCommandMenu();
  const [shortcut, setShortcut] = useState("⌘K");
  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("Ctrl K");
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        open();
      }}
      className="group flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13.5px] text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      data-testid="open-search"
    >
      <Search className="size-4 shrink-0 opacity-80" strokeWidth={1.8} />
      <span className="flex-1 truncate">Search</span>
      <kbd className="rounded border border-sidebar-border bg-sidebar px-1.5 font-sans text-[11px] leading-[18px] text-muted-foreground">
        {shortcut}
      </kbd>
    </button>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between pr-1 pl-2">
      <span className="text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
      {action}
    </div>
  );
}

export function Sidebar({ initial, onNavigate }: { initial: AppState; onNavigate?: () => void }) {
  const { data } = useAppState(initial);
  const state = data ?? initial;
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const groups = state.chats.filter((chat) => chat.kind === "group");
  const currentChatId = pathname.startsWith("/chats/") ? pathname.split("/")[2] : null;
  const currentChat = state.chats.find((chat) => chat.id === currentChatId);

  return (
    <nav aria-label="Main" className="flex h-full w-full flex-col bg-sidebar">
      <div className="desktop-titlebar shrink-0" aria-hidden />
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-md focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Wordmark />
        </Link>
        <NotificationsButton count={state.unreadNotifications} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2.5 pb-4">
        <div className="flex flex-col gap-0.5">
          <SearchItem onNavigate={onNavigate} />
          <NavItem
            href="/"
            icon={House}
            label="Home"
            active={pathname === "/"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/computer"
            icon={Monitor}
            label="Computer"
            active={pathname === "/computer"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/tasks"
            icon={ListTodo}
            label="Tasks"
            active={pathname === "/tasks"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/approvals"
            icon={ShieldCheck}
            label="Approvals"
            badge={state.pendingApprovals}
            active={pathname === "/approvals"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/automations"
            icon={Zap}
            label="Automations"
            active={pathname === "/automations"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/skills"
            icon={Sparkles}
            label="Skills"
            active={pathname === "/skills"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/files"
            icon={FolderClosed}
            label="Files"
            active={pathname === "/files"}
            onNavigate={onNavigate}
          />
          <NavItem
            href="/vault"
            icon={KeyRound}
            label="Vault"
            active={pathname === "/vault"}
            onNavigate={onNavigate}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <SectionHeader
            title="Teammates"
            action={
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" asChild>
                    <Link href="/bots/new" onClick={onNavigate} aria-label="New teammate">
                      <Plus />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New teammate</TooltipContent>
              </Tooltip>
            }
          />
          {state.bots.length === 0 && (
            <Link
              href="/bots/new"
              onClick={onNavigate}
              className="mx-1 mt-1 rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              Create your first teammate
            </Link>
          )}
          {state.bots.map((bot) => {
            const href = bot.directChatId ? `/chats/${bot.directChatId}` : `/bots/${bot.id}`;
            const active =
              (currentChat?.kind !== "group" && currentChat?.botId === bot.id) ||
              pathname === `/bots/${bot.id}`;
            return (
              <Link
                key={bot.id}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent",
                  active && "bg-sidebar-accent",
                )}
              >
                <BotAvatar
                  name={bot.name}
                  color={bot.color}
                  emoji={bot.emoji}
                  size="sm"
                  activity={botActivity(bot)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13.5px] leading-tight font-medium">
                    {bot.name}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12px] leading-tight text-muted-foreground",
                      bot.activeRun?.status === "waiting" && "text-waiting",
                    )}
                  >
                    {botStatusText(bot)}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>

        {(groups.length > 0 || state.bots.length >= 2) && (
          <div className="flex flex-col gap-0.5">
            <SectionHeader title="Group chats" action={<NewGroupDialog bots={state.bots} />} />
            {groups.length === 0 && (
              <p className="px-2 py-1 text-[12.5px] text-muted-foreground">
                Put teammates in one room and let them hand work to each other.
              </p>
            )}
            {groups.map((chat) => {
              const members = state.bots.filter((bot) => chat.memberIds.includes(bot.id));
              return (
                <Link
                  key={chat.id}
                  href={`/chats/${chat.id}`}
                  onClick={onNavigate}
                  aria-current={chat.id === currentChatId ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent",
                    chat.id === currentChatId && "bg-sidebar-accent",
                  )}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-subtle text-muted-foreground">
                    <Users className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] leading-tight font-medium">
                      {chat.title}
                    </span>
                    <span className="truncate text-[12px] leading-tight text-muted-foreground">
                      {members.map((member) => member.name).join(", ")}
                    </span>
                  </span>
                  {chat.active && (
                    <span className="size-2 shrink-0 animate-tally rounded-full bg-live" />
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2.5 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-[12px] font-semibold text-background">
                {state.user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate text-[13.5px] font-medium">{state.user.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="truncate text-sm font-medium">{state.user.name}</div>
              <div className="truncate text-xs text-muted-foreground">{state.user.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              {resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                await authClient.signOut();
                router.replace("/login");
              }}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              asChild
              className={cn(pathname === "/settings" && "bg-sidebar-accent")}
            >
              <Link
                href="/settings"
                onClick={onNavigate}
                aria-label="Settings"
                aria-current={pathname === "/settings" ? "page" : undefined}
              >
                <Settings />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
