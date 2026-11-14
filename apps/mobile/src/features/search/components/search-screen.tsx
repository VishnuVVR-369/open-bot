import { queryWords } from "@open-bot/chat-core";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import {
  Bell,
  FileText,
  House,
  MessageSquare,
  MessagesSquare,
  SearchX,
  Settings,
  ShieldCheck,
  TextSearch,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  SectionList,
  StyleSheet,
  View,
  type TextInputInstance,
} from "react-native";
import { Button } from "@/components/button";
import { ScopeChips, SearchField } from "@/features/search/components/search-controls";
import {
  SearchResultRow,
  type AppPlace,
  type AppSearchRow,
} from "@/features/search/components/search-row";
import { Empty } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { pageHref } from "@/features/pages/pages";
import { useChats, useNewDirectChat } from "@/features/chat/hooks";
import { useHome } from "@/features/home/hooks";
import { usePages } from "@/features/pages/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { queryKeys } from "@/lib/query";
import { SCOPES, searchSections, type Scope } from "@/features/search/search";
import { useDebounced } from "@/lib/use-debounced";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { space, useColors } from "@/theme";

const PAGES: AppPlace[] = [
  { title: "Home", href: "/", icon: House, keywords: "briefing activity away" },
  { title: "Chats", href: "/chats", icon: MessagesSquare, keywords: "conversations messages" },
  { title: "Approvals", href: "/approvals", icon: ShieldCheck, keywords: "approve deny rules" },
  { title: "Notifications", href: "/notifications", icon: Bell, keywords: "bell alerts" },
  { title: "New chat", href: "/new-chat", icon: MessageSquare, keywords: "start group" },
  {
    title: "Pages",
    href: "/pages",
    icon: FileText,
    keywords: "html explainers reports documents dashboards",
  },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
    keywords: "account sign out lock appearance dark haptics passkey",
  },
];

/** Find a teammate, a chat, a page, or something said, like the web's command menu. */
export default function Search() {
  const bottom = useSafeBottom();
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
  // Each word you type has to start a word in what it finds: "lis" finds Lisbon, not Publish.
  const words = useMemo(() => queryWords(text), [text]);
  const { data: teammates = [] } = useTeammates();
  const { data: chats = [] } = useChats();
  const { data: home } = useHome();
  const { data: madePages = [] } = usePages();
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

  const sections = useMemo(
    () =>
      searchSections({
        words,
        query,
        scope,
        teammates,
        chats,
        pages: madePages,
        places: PAGES,
        messages: messages.data ?? [],
      }),
    [teammates, chats, madePages, messages.data, query, scope, words],
  );

  const open = (row: AppSearchRow) => {
    switch (row.kind) {
      case "teammate":
        if (row.teammate.directChatId) router.replace(`/chats/${row.teammate.directChatId}`);
        else newChat.mutate(row.teammate.id);
        return;
      case "chat":
        router.replace(`/chats/${row.chatId}`);
        return;
      case "place":
        router.replace(row.href);
        return;
      case "page":
        router.replace(pageHref(row.page.id));
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
            <SearchField
              input={input}
              text={text}
              onChangeText={setText}
              searching={searchingMessages}
            />
          ),
        }}
      />
      <ScopeChips scope={scope} onPick={pickScope} />
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: bottom }}
        renderSectionHeader={({ section }) =>
          // One kind of thing needs no heading saying which.
          scope === "all" ? (
            <Text variant="overline" muted style={styles.section} accessibilityRole="header">
              {section.title}
            </Text>
          ) : null
        }
        ListEmptyComponent={empty}
        renderItem={({ item: row }) => (
          <SearchResultRow row={row} words={words} you={you} onPress={() => open(row)} />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: space(4),
    paddingTop: space(4),
    paddingBottom: space(1),
  },
  searching: { padding: space(8), alignItems: "center" },
});
