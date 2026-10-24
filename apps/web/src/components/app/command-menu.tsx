"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  FolderClosed,
  KeyRound,
  Plug,
  House,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  ListTodo,
  Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { BotAvatar } from "@/components/bot-avatar";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { getJson } from "@/lib/client/api";
import { useAppState } from "@/lib/client/queries";
import { chatHref } from "@/lib/utils";
import type { SearchResultView } from "@/lib/types";

const CommandMenuContext = createContext<{ open: () => void }>({ open: () => {} });

/** Opens the command menu, for buttons that offer search. */
export function useCommandMenu() {
  return useContext(CommandMenuContext);
}

const PAGES = [
  { href: "/", label: "Home", icon: House },
  { href: "/computer", label: "Computer", icon: Monitor },
  { href: "/tasks", label: "Tasks", icon: ListTodo, keywords: "board to-do todo kanban" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  {
    href: "/automations",
    label: "Automations",
    icon: Zap,
    keywords: "schedules routines reminders page watches webhooks",
  },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/files", label: "Files", icon: FolderClosed },
  {
    href: "/vault",
    label: "Vault",
    icon: KeyRound,
    keywords: "passwords logins cards payment budget",
  },
  {
    href: "/settings#connections",
    label: "Connections",
    icon: Plug,
    keywords: "mcp integrations github notion api services",
  },
  { href: "/settings", label: "Settings", icon: Settings },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The excerpt with each occurrence of the query marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    <>
      {text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={index} className="rounded-[3px] bg-waiting/20 px-px text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const { data: state } = useAppState();
  const { resolvedTheme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const searchFor = useDebounced(query.trim(), 200);
  const { data: results, isFetching } = useQuery({
    queryKey: ["search", searchFor],
    queryFn: () => getJson<SearchResultView[]>(`/api/search?q=${encodeURIComponent(searchFor)}`),
    enabled: open && searchFor.length >= 2,
    staleTime: 10_000,
    // Keep the last results while you type, so the list doesn't flicker.
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const allBots = state?.bots ?? [];
  const chats = state?.chats ?? [];
  const botOf = (id: string | null) => allBots.find((bot) => bot.id === id);
  const chatOf = (id: string) => chats.find((chat) => chat.id === id);
  const searching = searchFor.length >= 2;

  // Every word you type has to appear somewhere in the item.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: string[]) => {
    const haystack = texts.join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  };
  const bots = allBots.filter((bot) => matches(bot.name, bot.role));
  const groups = chats.filter(
    (chat) =>
      chat.kind === "group" &&
      matches(chat.title, ...chat.memberIds.map((id) => botOf(id)?.name ?? "")),
  );
  const pages = PAGES.filter((page) =>
    matches(page.label, ("keywords" in page && page.keywords) || ""),
  );
  const themeLabel = resolvedTheme === "dark" ? "Light mode" : "Dark mode";
  const showNewTeammate = matches("new teammate create bot");
  const showTheme = matches(themeLabel, "theme switch appearance");
  const messageResults = searching && words.length > 0 ? (results ?? []) : [];
  const nothing =
    bots.length + groups.length + pages.length + messageResults.length === 0 &&
    !showNewTeammate &&
    !showTheme;

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  const directChat = (botId: string) =>
    chats
      .filter((chat) => chat.kind === "direct" && chat.botId === botId)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Jump to a teammate, a chat or a page, or search your messages."
      className="top-[14vh] sm:max-w-xl"
    >
      <Command shouldFilter={false} className="[&_[data-slot=command-item]>svg:last-child]:hidden">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search teammates, chats and messages…"
          data-testid="command-input"
        />
        <CommandList className="max-h-[min(60vh,440px)]">
          {nothing && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {searching && isFetching ? "Searching…" : "Nothing matches that."}
            </div>
          )}
          {bots.length > 0 && (
            <CommandGroup heading="Teammates">
              {bots.map((bot) => (
                <CommandItem
                  key={bot.id}
                  value={`teammate-${bot.id}`}
                  onSelect={() => {
                    const chat = directChat(bot.id);
                    go(chat ? `/chats/${chat.id}` : `/bots/${bot.id}`);
                  }}
                >
                  <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                  <span>{bot.name}</span>
                  <span className="truncate text-muted-foreground">{bot.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {groups.length > 0 && (
            <CommandGroup heading="Group chats">
              {groups.map((chat) => (
                <CommandItem
                  key={chat.id}
                  value={`group-${chat.id}`}
                  onSelect={() => go(`/chats/${chat.id}`)}
                >
                  <Users />
                  <span>{chat.title}</span>
                  <span className="truncate text-muted-foreground">
                    {chat.memberIds
                      .map((id) => botOf(id)?.name)
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {messageResults.length > 0 && (
            <CommandGroup heading="Messages">
              {messageResults.map((result) => {
                const bot = botOf(result.botId);
                const chat = chatOf(result.chatId);
                return (
                  <CommandItem
                    key={result.id}
                    value={`message-${result.id}`}
                    onSelect={() => go(chatHref(result.chatId, result.runId))}
                    className="items-start py-2"
                    data-testid="search-result"
                  >
                    {bot ? (
                      <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                    ) : (
                      <MessageSquare className="mt-0.5 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {result.from === "you" ? "You" : (bot?.name ?? "Former teammate")}
                        </span>
                        {chat && <span className="truncate">in {chat.title}</span>}
                        <span className="ml-auto shrink-0">
                          {formatDistanceToNowStrict(new Date(result.createdAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[13px] leading-snug">
                        <Highlighted text={result.excerpt} query={searchFor} />
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {pages.length > 0 && (
            <CommandGroup heading="Go to">
              {pages.map((page) => (
                <CommandItem
                  key={page.href}
                  value={`page-${page.href}`}
                  onSelect={() => go(page.href)}
                >
                  <page.icon />
                  {page.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {(showNewTeammate || showTheme) && (
            <CommandGroup heading="Actions">
              {showNewTeammate && (
                <CommandItem value="action-new-teammate" onSelect={() => go("/bots/new")}>
                  <Plus />
                  New teammate
                </CommandItem>
              )}
              {showTheme && (
                <CommandItem
                  value="action-theme"
                  onSelect={() => {
                    setTheme(resolvedTheme === "dark" ? "light" : "dark");
                    onOpenChange(false);
                  }}
                >
                  {resolvedTheme === "dark" ? <Sun /> : <Moon />}
                  {themeLabel}
                </CommandItem>
              )}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-[11.5px] text-muted-foreground">
          <span>
            <CommandShortcut className="ml-0 tracking-normal">↑↓</CommandShortcut> to move
          </span>
          <span>
            <CommandShortcut className="ml-0 tracking-normal">↵</CommandShortcut> to open
          </span>
          <span>
            <CommandShortcut className="ml-0 tracking-normal">esc</CommandShortcut> to close
          </span>
        </div>
      </Command>
    </CommandDialog>
  );
}

/** ⌘K anywhere in the app opens search. */
export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openMenu = useCallback(() => setOpen(true), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Keys typed into a screen you control belong to that computer.
      if (event.target instanceof Element && event.target.closest(".novnc-host")) return;
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ open: openMenu }), [openMenu]);
  return (
    <CommandMenuContext.Provider value={value}>
      {children}
      <CommandMenu open={open} onOpenChange={setOpen} />
    </CommandMenuContext.Provider>
  );
}
