"use client";

import {
  CloudOff,
  FileText,
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
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { TeammateAvatar } from "@/components/teammate-avatar";
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
import { useAppState } from "@/features/app-shell";
import { COMPUTER_OFFLINE_LINE, isComputerOnline, teammateStatus } from "@/lib/status";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useCommandMenu } from "./command-menu";
import { NewGroupDialog } from "./new-group-dialog";
import { NotificationsButton } from "@/features/notifications";

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
        "group flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13.5px] text-sidebar-foreground/70 transition-[background-color,color,box-shadow] hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        active &&
          "bg-surface font-medium text-sidebar-foreground shadow-raised hover:bg-surface dark:bg-sidebar-accent",
      )}
    >
      <Icon
        className={cn("size-4 shrink-0 opacity-70", active && "opacity-100")}
        strokeWidth={1.8}
      />
      <span className="flex-1 truncate">{label}</span>
      {badge ? (
        <span className="min-w-5 rounded-full bg-attention px-1.5 text-center text-[11px] leading-[18px] font-semibold text-black/85 tabular-nums">
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
      className="group mb-1 flex h-8 items-center gap-2.5 rounded-lg border border-sidebar-border bg-surface/60 px-2 text-left text-[13.5px] text-sidebar-foreground/60 transition-colors hover:bg-surface hover:text-sidebar-foreground dark:bg-sidebar-accent/50 dark:hover:bg-sidebar-accent"
      data-testid="open-search"
    >
      <Search className="size-4 shrink-0 opacity-70" strokeWidth={1.8} />
      <span className="flex-1 truncate">Search</span>
      {/* A keyboard shortcut means nothing on a touch screen. */}
      <kbd className="rounded-[5px] bg-sidebar-accent px-1.5 font-sans text-[11px] leading-[18px] text-muted-foreground pointer-coarse:hidden">
        {shortcut}
      </kbd>
    </button>
  );
}

interface NavEntry {
  href: string;
  icon: typeof House;
  label: string;
  /** Also current on these paths, like a page under Pages. */
  prefix?: string;
}

/** Where you go most: always first. */
const PRIMARY_NAV: NavEntry[] = [
  { href: "/", icon: House, label: "Home" },
  { href: "/computer", icon: Monitor, label: "Computer" },
  { href: "/tasks", icon: ListTodo, label: "Tasks" },
  { href: "/approvals", icon: ShieldCheck, label: "Approvals" },
];

/** Tools you set up and come back to now and then. */
const TOOLS_NAV: NavEntry[] = [
  { href: "/automations", icon: Zap, label: "Automations" },
  { href: "/skills", icon: Sparkles, label: "Skills" },
  { href: "/pages", icon: FileText, label: "Pages", prefix: "/pages/" },
  { href: "/files", icon: FolderClosed, label: "Files" },
  { href: "/vault", icon: KeyRound, label: "Vault" },
];

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between pr-1 pl-2">
      <span className="text-[12px] font-medium text-muted-foreground">{title}</span>
      {action}
    </div>
  );
}

export function Sidebar({
  initial,
  onNavigate,
  onClose,
}: {
  initial: AppState;
  onNavigate?: () => void;
  /** Shown as a close button, when the sidebar is a drawer over the page. */
  onClose?: () => void;
}) {
  const { data } = useAppState(initial);
  const state = data ?? initial;
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const groups = state.chats.filter((chat) => chat.kind === "group");
  const currentChatId = pathname.startsWith("/chats/") ? pathname.split("/")[2] : null;
  const currentChat = state.chats.find((chat) => chat.id === currentChatId);
  const computerOnline = isComputerOnline(state);
  const drawer = Boolean(onClose);
  const navItem = (entry: NavEntry) => (
    <NavItem
      key={entry.href}
      href={entry.href}
      icon={entry.icon}
      label={entry.label}
      badge={entry.href === "/approvals" ? state.pendingApprovals : undefined}
      active={pathname === entry.href || Boolean(entry.prefix && pathname.startsWith(entry.prefix))}
      onNavigate={onNavigate}
    />
  );

  return (
    <nav
      aria-label="Main"
      className="flex h-full w-full flex-col bg-sidebar [--avatar-ring:var(--sidebar)]"
    >
      <div className="desktop-titlebar shrink-0" aria-hidden />
      <div className="flex h-14 shrink-0 items-center justify-between pr-3 pl-4">
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-md focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Wordmark />
        </Link>
        <div className="flex items-center gap-0.5">
          <NotificationsButton count={state.unreadNotifications} />
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close menu"
              onClick={onClose}
              data-testid="close-menu"
            >
              <X />
            </Button>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The bottom padding lets the last row scroll clear of the fade above the account row. */}
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2.5 pt-1 pb-8">
          <div className="flex flex-col gap-0.5">
            <SearchItem onNavigate={onNavigate} />
            {/* The phone menu reads top to bottom: where you go most, your teammates, then tools. */}
            {(drawer ? PRIMARY_NAV : [...PRIMARY_NAV, ...TOOLS_NAV]).map(navItem)}
          </div>

          <div className="flex flex-col gap-0.5">
            <SectionHeader
              title="Teammates"
              action={
                <span className="flex min-w-0 items-center gap-1">
                  {!computerOnline && state.teammates.length > 0 && (
                    // Said once, beside the heading, so each row below can just say "Paused".
                    <Link
                      href="/computer"
                      onClick={onNavigate}
                      className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
                      data-testid="sidebar-computer-offline"
                    >
                      <CloudOff className="size-3.5 shrink-0" strokeWidth={1.8} />
                      <span className="truncate">{COMPUTER_OFFLINE_LINE}</span>
                    </Link>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs" asChild>
                        <Link href="/teammates/new" onClick={onNavigate} aria-label="New teammate">
                          <Plus />
                        </Link>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">New teammate</TooltipContent>
                  </Tooltip>
                </span>
              }
            />
            {state.teammates.length === 0 && (
              <Link
                href="/teammates/new"
                onClick={onNavigate}
                className="mx-1 mt-1 rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                Create your first teammate
              </Link>
            )}
            {state.teammates.map((teammate) => {
              const href = teammate.directChatId
                ? `/chats/${teammate.directChatId}`
                : `/teammates/${teammate.id}`;
              const active =
                (currentChat?.kind !== "group" && currentChat?.teammateId === teammate.id) ||
                pathname === `/teammates/${teammate.id}`;
              const status = teammateStatus(teammate, computerOnline);
              return (
                <Link
                  key={teammate.id}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  // The line under the name is status only; their job shows on hover.
                  title={`${teammate.name}, ${teammate.role}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-[background-color,box-shadow] hover:bg-sidebar-accent/70",
                    active &&
                      "bg-surface shadow-raised [--avatar-ring:var(--surface)] hover:bg-surface dark:bg-sidebar-accent dark:[--avatar-ring:var(--sidebar-accent)]",
                  )}
                  data-testid={`sidebar-teammate-${teammate.slug}`}
                >
                  <TeammateAvatar
                    name={teammate.name}
                    color={teammate.color}
                    emoji={teammate.emoji}
                    size="sm"
                    activity={status.activity}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13.5px] leading-tight font-medium">
                      {teammate.name}
                    </span>
                    <span
                      className={cn(
                        "truncate text-[12px] leading-tight text-muted-foreground",
                        status.needsYou && "text-attention-ink",
                      )}
                      data-testid="teammate-status"
                    >
                      {status.label}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>

          {(groups.length > 0 || state.teammates.length >= 2) && (
            <div className="flex flex-col gap-0.5">
              <SectionHeader
                title="Group chats"
                action={<NewGroupDialog teammates={state.teammates} />}
              />
              {groups.length === 0 && (
                <p className="px-2 py-1 text-[12.5px] text-muted-foreground">
                  Put teammates in one room and let them hand work to each other.
                </p>
              )}
              {groups.map((chat) => {
                const members = state.teammates.filter((teammate) =>
                  chat.memberIds.includes(teammate.id),
                );
                return (
                  <Link
                    key={chat.id}
                    href={`/chats/${chat.id}`}
                    onClick={onNavigate}
                    aria-current={chat.id === currentChatId ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-[background-color,box-shadow] hover:bg-sidebar-accent/70",
                      chat.id === currentChatId &&
                        "bg-surface shadow-raised hover:bg-surface dark:bg-sidebar-accent",
                    )}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-sidebar-accent text-muted-foreground">
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
                    {chat.active && computerOnline && (
                      <span
                        className="size-2 shrink-0 animate-tally rounded-full bg-working"
                        aria-label="Working"
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          )}
          {drawer && (
            <div className="flex flex-col gap-0.5">
              <SectionHeader title="Tools" />
              {TOOLS_NAV.map(navItem)}
            </div>
          )}
        </div>
        {/* Where the list runs on under the account row, it fades out instead of being cut. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-sidebar to-transparent"
        />
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2.5 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-foreground/85 to-foreground text-[12px] font-semibold text-background">
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
