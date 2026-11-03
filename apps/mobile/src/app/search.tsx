import type { BotSummary, SearchResult } from "@open-bot/api";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useNavigation, type Href } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import {
  Bell,
  CalendarClock,
  House,
  Mail,
  MessageSquare,
  MessagesSquare,
  Search as SearchIcon,
  Settings,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { chatSubtitle, chatTitle } from "@/lib/chats";
import { chatHref } from "@/lib/links";
import { useChats, useNewDirectChat, useTeammates } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { fonts, radius, space, useColors } from "@/theme";

const PAGES: { title: string; href: Href; icon: LucideIcon; keywords: string }[] = [
  { title: "Home", href: "/", icon: House, keywords: "briefing activity away" },
  { title: "Chats", href: "/chats", icon: MessagesSquare, keywords: "conversations messages" },
  { title: "Approvals", href: "/approvals", icon: ShieldCheck, keywords: "approve deny rules" },
  { title: "Notifications", href: "/notifications", icon: Bell, keywords: "bell alerts" },
  { title: "New chat", href: "/new-chat", icon: MessageSquare, keywords: "start group" },
  { title: "Settings", href: "/settings", icon: Settings, keywords: "account sign out lock" },
];

type Row =
  | { kind: "bot"; key: string; bot: BotSummary }
  | {
      kind: "chat";
      key: string;
      chatId: string;
      title: string;
      subtitle: string;
      icon: LucideIcon;
      bot?: BotSummary;
    }
  | { kind: "page"; key: string; title: string; href: Href; icon: LucideIcon }
  | { kind: "message"; key: string; result: SearchResult; bot?: BotSummary; chat: string };

const matches = (query: string, ...texts: (string | undefined)[]) =>
  texts.some((text) => text?.toLowerCase().includes(query));

/** Your text, with the part that matched in bold. */
function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query) : -1;
  if (index < 0)
    return (
      <Text variant="small" muted numberOfLines={2}>
        {text}
      </Text>
    );
  return (
    <Text variant="small" muted numberOfLines={2}>
      {text.slice(0, index)}
      <Text variant="small" style={{ fontWeight: "600" }}>
        {text.slice(index, index + query.length)}
      </Text>
      {text.slice(index + query.length)}
    </Text>
  );
}

/** A teammate's tile for what's theirs, an icon for the rest. */
function Leading({ row }: { row: Row }) {
  const colors = useColors();
  const bot = row.kind === "page" ? undefined : row.bot;
  if (bot) return <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="md" />;
  const Icon = row.kind === "chat" || row.kind === "page" ? row.icon : MessageSquare;
  return (
    <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
      <Icon size={18} color={colors.mutedForeground} />
    </View>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Find a teammate, a chat, a page, or something said, like the web's command menu. */
export default function Search() {
  const colors = useColors();
  const [text, setText] = useState("");
  const input = useRef<TextInputInstance>(null);
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  // Android drops a focus asked for while the screen is still fading in, so ask once it's in.
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (event) => {
        if (!event.data.closing) input.current?.focus();
      }),
    [navigation],
  );
  const query = text.trim().toLowerCase();
  const { data: bots = [] } = useTeammates();
  const { data: chats = [] } = useChats();
  const newChat = useNewDirectChat();
  const messageQuery = useDebounced(text.trim(), 250);
  const messages = useQuery({
    queryKey: queryKeys.search(messageQuery),
    queryFn: () => api.search.messages({ query: messageQuery }),
    enabled: messageQuery.length >= 2,
    placeholderData: (previous) => previous,
  });

  const sections = useMemo(() => {
    const teammateRows: Row[] = bots
      .filter((bot) => !query || matches(query, bot.name, bot.role))
      .slice(0, query ? 6 : 8)
      .map((bot) => ({ kind: "bot", key: `b:${bot.id}`, bot }));
    const chatRows: Row[] = [...chats]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((chat) => {
        const bot = bots.find((candidate) => candidate.id === chat.botId);
        return {
          kind: "chat" as const,
          key: `c:${chat.id}`,
          chatId: chat.id,
          title: chatTitle(chat, bot),
          subtitle: chatSubtitle(chat, bot, bots),
          icon:
            chat.kind === "group"
              ? Users
              : chat.kind === "scheduled"
                ? CalendarClock
                : chat.kind === "inbox"
                  ? Mail
                  : MessageSquare,
          bot: chat.kind === "group" ? undefined : bot,
        };
      })
      .filter((row) => !query || matches(query, row.title, row.subtitle))
      .slice(0, query ? 8 : 5);
    const pageRows: Row[] = PAGES.filter(
      (page) => !query || matches(query, page.title, page.keywords),
    ).map((page) => ({ kind: "page", key: `p:${page.title}`, ...page }));
    const messageRows: Row[] =
      query.length >= 2
        ? (messages.data ?? []).map((result) => {
            const chat = chats.find((candidate) => candidate.id === result.chatId);
            const bot = bots.find((candidate) => candidate.id === result.botId);
            return {
              kind: "message",
              key: `m:${result.id}`,
              result,
              bot,
              chat: chat
                ? chatTitle(
                    chat,
                    bots.find((b) => b.id === chat.botId),
                  )
                : "A chat",
            };
          })
        : [];
    return [
      { title: "Teammates", data: teammateRows },
      { title: query ? "Chats" : "Recent chats", data: chatRows },
      { title: "Messages", data: messageRows },
      { title: "Pages", data: pageRows },
    ].filter((section) => section.data.length > 0);
  }, [bots, chats, messages.data, query]);

  const open = (row: Row) => {
    switch (row.kind) {
      case "bot":
        if (row.bot.directChatId) router.replace(`/chats/${row.bot.directChatId}`);
        else newChat.mutate(row.bot.id);
        return;
      case "chat":
        router.replace(`/chats/${row.chatId}`);
        return;
      case "page":
        router.replace(row.href);
        return;
      case "message":
        router.replace(chatHref(row.result.chatId, row.result.runId));
    }
  };

  const searchingMessages =
    query.length >= 2 && (messages.isFetching || messageQuery !== text.trim());

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={[styles.field, { backgroundColor: colors.subtle }]}>
              <SearchIcon size={17} color={colors.mutedForeground} />
              <TextInput
                value={text}
                ref={input}
                onChangeText={setText}
                placeholder="Teammates, chats, messages…"
                placeholderTextColor={colors.mutedForeground}
                cursorColor={colors.foreground}
                selectionColor={colors.input}
                returnKeyType="search"
                autoCorrect={false}
                style={[styles.input, { color: colors.foreground }]}
                testID="search-input"
              />
              {searchingMessages ? (
                <ActivityIndicator size={14} color={colors.mutedForeground} />
              ) : text ? (
                <Pressable onPress={() => setText("")} hitSlop={10} accessibilityLabel="Clear">
                  <X size={17} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space(8) }}
        renderSectionHeader={({ section }) => (
          <Text variant="caption" muted style={styles.section}>
            {section.title.toUpperCase()}
          </Text>
        )}
        ListEmptyComponent={
          query && !searchingMessages ? (
            <View style={styles.empty}>
              <Text muted>Nothing matches “{text.trim()}”.</Text>
            </View>
          ) : undefined
        }
        renderItem={({ item: row }) => (
          <Pressable
            onPress={() => open(row)}
            android_ripple={{ color: colors.muted }}
            style={styles.row}
            accessibilityRole="button"
            testID={`search-${row.kind}`}
          >
            <Leading row={row} />
            <View style={{ flex: 1, gap: 1 }}>
              {row.kind === "bot" ? (
                <>
                  <Text variant="label" numberOfLines={1}>
                    {row.bot.name}
                  </Text>
                  <Text variant="small" muted numberOfLines={1}>
                    {row.bot.role}
                  </Text>
                </>
              ) : row.kind === "chat" ? (
                <>
                  <Text variant="label" numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text variant="small" muted numberOfLines={1}>
                    {row.subtitle}
                  </Text>
                </>
              ) : row.kind === "page" ? (
                <Text variant="label">{row.title}</Text>
              ) : (
                <>
                  <View style={styles.messageHead}>
                    <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {row.result.from === "you" ? "You" : (row.bot?.name ?? "A teammate")}
                      <Text variant="small" muted>
                        {"  "}in {row.chat}
                      </Text>
                    </Text>
                    <Text variant="caption" muted style={{ marginLeft: "auto" }}>
                      {ago(row.result.createdAt)}
                    </Text>
                  </View>
                  <Highlight text={row.result.excerpt} query={query} />
                </>
              )}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    height: 40,
    borderRadius: radius.lg,
    paddingHorizontal: space(3),
    // The header leaves room for the back button.
    width: "100%",
    minWidth: 260,
  },
  input: { flex: 1, fontFamily: fonts.sans, fontSize: 15, paddingVertical: 0 },
  section: {
    letterSpacing: 0.6,
    fontWeight: "500",
    paddingHorizontal: space(4),
    paddingTop: space(5),
    paddingBottom: space(1),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
    minHeight: 56,
  },
  mark: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  messageHead: { flexDirection: "row", alignItems: "center", gap: space(2) },
  empty: { padding: space(8), alignItems: "center" },
});
