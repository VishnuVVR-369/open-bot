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
  SearchX,
  Settings,
  ShieldCheck,
  TextSearch,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import { BotAvatar, botActivity, GroupAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { Empty } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { chatSubtitle, chatTitle } from "@/lib/chats";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { useChats, useHome, useNewDirectChat, useTeammates } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { fonts, radius, space, useColors } from "@/theme";

const PAGES: { title: string; href: Href; icon: LucideIcon; keywords: string }[] = [
  { title: "Home", href: "/", icon: House, keywords: "briefing activity away" },
  { title: "Chats", href: "/chats", icon: MessagesSquare, keywords: "conversations messages" },
  { title: "Approvals", href: "/approvals", icon: ShieldCheck, keywords: "approve deny rules" },
  { title: "Notifications", href: "/notifications", icon: Bell, keywords: "bell alerts" },
  { title: "New chat", href: "/new-chat", icon: MessageSquare, keywords: "start group" },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
    keywords: "account sign out lock appearance dark haptics passkey",
  },
];

/** What to look through: everything, or one kind of thing. Messages are searched on the server. */
const SCOPES = [
  { key: "all", label: "All" },
  { key: "teammates", label: "Teammates" },
  { key: "chats", label: "Chats" },
  { key: "messages", label: "Messages" },
] as const;
type Scope = (typeof SCOPES)[number]["key"];

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
      members?: BotSummary[];
    }
  | { kind: "page"; key: string; title: string; href: Href; icon: LucideIcon }
  | {
      kind: "message";
      key: string;
      result: SearchResult;
      /** Who said it: a teammate, or you (undefined). */
      bot?: BotSummary;
      /** Who said it, and where when that adds something: "Rex", "You to Rex", "Iris in Trip". */
      who: string;
      where: string | null;
    };

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

/** A teammate's face for what's theirs, your initial for what you said, an icon for the rest. */
function Leading({ row, you }: { row: Row; you: string }) {
  const colors = useColors();
  if (row.kind === "chat" && row.members && row.members.length > 1)
    return <GroupAvatar members={row.members} size="md" />;
  const bot = row.kind === "page" ? undefined : row.bot;
  if (bot)
    return (
      <BotAvatar
        name={bot.name}
        color={bot.color}
        emoji={bot.emoji}
        size="md"
        activity={row.kind === "bot" ? botActivity(bot) : "idle"}
      />
    );
  if (row.kind === "message")
    return (
      <View style={[styles.mark, styles.you, { backgroundColor: colors.primary }]}>
        <Text
          allowFontScaling={false}
          style={[styles.youText, { color: colors.primaryForeground }]}
        >
          {you}
        </Text>
      </View>
    );
  const Icon = row.kind === "chat" || row.kind === "page" ? row.icon : MessageSquare;
  return (
    <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
      <Icon size={20} color={colors.foreground} />
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Search ${label.toLowerCase()}`}
      testID={`search-scope-${label.toLowerCase()}`}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: colors.primary, borderColor: colors.primary }
          : { backgroundColor: colors.surface, borderColor: colors.input },
      ]}
    >
      <Text
        variant="small"
        style={{
          color: selected ? colors.primaryForeground : colors.foreground,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
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
  const [scope, setScope] = useState<Scope>("all");
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
  const { data: home } = useHome();
  const you = home?.user.name.trim()[0]?.toUpperCase() ?? "Y";
  const newChat = useNewDirectChat();
  const messageQuery = useDebounced(text.trim(), 250);
  const wantsMessages = scope === "all" || scope === "messages";
  const messages = useQuery({
    queryKey: queryKeys.search(messageQuery),
    queryFn: () => api.search.messages({ query: messageQuery }),
    enabled: wantsMessages && messageQuery.length >= 2,
    placeholderData: (previous) => previous,
  });

  const sections = useMemo(() => {
    const only = scope !== "all";
    const teammateRows: Row[] = bots
      .filter((bot) => !query || matches(query, bot.name, bot.role))
      .slice(0, only ? undefined : query ? 6 : 8)
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
              ? MessagesSquare
              : chat.kind === "scheduled"
                ? CalendarClock
                : chat.kind === "inbox"
                  ? Mail
                  : MessageSquare,
          bot: chat.kind === "group" ? undefined : bot,
          members:
            chat.kind === "group"
              ? chat.memberIds
                  .map((id) => bots.find((member) => member.id === id))
                  .filter((member): member is BotSummary => Boolean(member))
              : undefined,
        };
      })
      .filter((row) => !query || matches(query, row.title, row.subtitle))
      .slice(0, only ? undefined : query ? 8 : 5);
    const pageRows: Row[] = PAGES.filter(
      (page) => !query || matches(query, page.title, page.keywords),
    ).map((page) => ({ kind: "page", key: `p:${page.title}`, ...page }));
    const messageRows: Row[] =
      query.length >= 2
        ? (messages.data ?? []).map((result) => {
            const chat = chats.find((candidate) => candidate.id === result.chatId);
            const chatBot = bots.find((candidate) => candidate.id === chat?.botId);
            const bot = bots.find((candidate) => candidate.id === result.botId);
            const place = chat ? chatTitle(chat, chatBot) : null;
            const direct = chat?.kind === "direct";
            const speaker = result.from === "you" ? "You" : (bot?.name ?? "A teammate");
            // A direct chat is named after its teammate: "Rex in Rex" says nothing new.
            const where =
              result.from === "you"
                ? place && (direct ? `to ${place}` : `in ${place}`)
                : place && place !== speaker && !(direct && chatBot?.id === bot?.id)
                  ? `in ${place}`
                  : null;
            return {
              kind: "message",
              key: `m:${result.id}`,
              result,
              bot: result.from === "you" ? undefined : bot,
              who: speaker,
              where,
            };
          })
        : [];
    const all = [
      { scope: "teammates", title: "Teammates", data: teammateRows },
      { scope: "chats", title: query ? "Chats" : "Recent chats", data: chatRows },
      { scope: "messages", title: "Messages", data: messageRows },
      { scope: "all", title: "Pages", data: pageRows },
    ];
    return all.filter(
      (section) => section.data.length > 0 && (scope === "all" || section.scope === scope),
    );
  }, [bots, chats, messages.data, query, scope]);

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
    wantsMessages && query.length >= 2 && (messages.isFetching || messageQuery !== text.trim());
  const pickScope = (next: Scope) => {
    if (next === scope) return;
    haptics.tap();
    setScope(next);
  };

  const empty =
    scope === "messages" && query.length < 2 ? (
      <Empty
        icon={<TextSearch size={28} color={colors.mutedForeground} />}
        title="Search what was said"
        body="Type a word or two to find it in your messages and your teammates' replies."
      />
    ) : query && !searchingMessages ? (
      <Empty
        icon={<SearchX size={28} color={colors.mutedForeground} />}
        title={`No results for “${text.trim()}”`}
        body={
          scope === "all"
            ? "Try a teammate's name, or a word from something that was said."
            : `Nothing in ${SCOPES.find((entry) => entry.key === scope)!.label.toLowerCase()} matches. Try looking everywhere.`
        }
        action={
          scope !== "all" ? (
            <Button title="Search everything" variant="outline" onPress={() => pickScope("all")} />
          ) : undefined
        }
      />
    ) : searchingMessages ? (
      <View style={styles.searching}>
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    ) : undefined;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View
              style={[
                styles.field,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <SearchIcon size={18} color={colors.mutedForeground} />
              <TextInput
                value={text}
                ref={input}
                onChangeText={setText}
                placeholder="Search teammates, chats, messages"
                placeholderTextColor={colors.mutedForeground}
                cursorColor={colors.foreground}
                selectionColor={colors.input}
                returnKeyType="search"
                autoCorrect={false}
                style={[styles.input, { color: colors.foreground }]}
                testID="search-input"
              />
              {searchingMessages ? (
                <ActivityIndicator size={16} color={colors.mutedForeground} />
              ) : text ? (
                <Pressable
                  onPress={() => {
                    setText("");
                    input.current?.focus();
                  }}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Clear"
                >
                  <X size={18} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.chipBar}
        contentContainerStyle={styles.chips}
      >
        {SCOPES.map((entry) => (
          <Chip
            key={entry.key}
            label={entry.label}
            selected={scope === entry.key}
            onPress={() => pickScope(entry.key)}
          />
        ))}
      </ScrollView>
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space(8) }}
        renderSectionHeader={({ section }) =>
          // One kind of thing needs no heading saying which.
          scope === "all" ? (
            <Text variant="caption" muted style={styles.section} accessibilityRole="header">
              {section.title.toUpperCase()}
            </Text>
          ) : null
        }
        ListEmptyComponent={empty}
        renderItem={({ item: row }) => (
          <Pressable
            onPress={() => open(row)}
            android_ripple={{ color: colors.muted }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
            accessibilityRole="button"
            testID={`search-${row.kind}`}
          >
            <Leading row={row} you={you} />
            <View style={{ flex: 1, gap: 2 }}>
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
                      {row.who}
                      {row.where && (
                        <Text variant="small" muted>
                          {" "}
                          {row.where}
                        </Text>
                      )}
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
    height: 44,
    // A pill, like the chat composer.
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingLeft: space(3.5),
    paddingRight: space(3),
    // The header leaves room for the back button.
    width: "100%",
    minWidth: 260,
  },
  input: { flex: 1, fontFamily: fonts.sans, fontSize: 15, paddingVertical: 0 },
  chipBar: { flexGrow: 0 },
  chips: {
    gap: space(2),
    paddingHorizontal: space(4),
    paddingTop: space(1),
    paddingBottom: space(2),
  },
  chip: {
    height: 32,
    paddingHorizontal: space(3.5),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
  section: {
    letterSpacing: 0.6,
    fontWeight: "500",
    paddingHorizontal: space(4),
    paddingTop: space(4),
    paddingBottom: space(1),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
    minHeight: 60,
  },
  mark: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  you: { borderRadius: radius.full },
  youText: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 16, lineHeight: 20 },
  messageHead: { flexDirection: "row", alignItems: "center", gap: space(2) },
  searching: { padding: space(8), alignItems: "center" },
});
