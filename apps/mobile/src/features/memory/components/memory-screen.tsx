import { MEMORY_LIST_LIMIT } from "@open-bot/domain";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Brain, Plus, Search, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { FilterChips } from "@/components/filter-chips";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { ConnectionNotice } from "@/features/computer/components/connection-notice";
import { HeaderButton } from "@/features/home/components/header-actions";
import { useTeammates } from "@/features/teammates/hooks";
import { haptics } from "@/lib/haptics";
import { useDebounced } from "@/lib/use-debounced";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { useMemories } from "../hooks";
import {
  memoryHref,
  memoryListBody,
  memoryScopes,
  newMemoryHref,
  scopeTeammate,
  SHARED_SCOPE,
} from "../memory";
import { MemoryRow } from "./memory-row";

/**
 * What teammates remember: the facts every teammate shares, or one teammate's own, with a search
 * over them. A teammate's suggestions show here too, to confirm or dismiss.
 */
export default function MemoryScreen() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const params = useLocalSearchParams<{ teammateId?: string }>();
  const [scope, setScope] = useState(params.teammateId ?? SHARED_SCOPE);
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 250);
  const teammateId = scopeTeammate(scope);
  const memories = useMemories(teammateId, query);
  const teammates = useTeammates();
  const all = useMemo(() => teammates.data ?? [], [teammates.data]);
  const scopes = useMemo(() => memoryScopes(all), [all]);
  const teammate = all.find((entry) => entry.id === teammateId);
  const { refreshing, onRefresh } = usePullToRefresh(() => memories.refetch());
  const items = memories.data ?? [];
  const savedBy = (id: string | undefined) => all.find((entry) => entry.id === id)?.name ?? null;
  // Results for an older search stay up while the new one loads, faded.
  const searching = memories.isPlaceholderData || text.trim() !== query;

  const header = (
    <Stack.Screen
      options={{
        title: "Memory",
        headerRight: () => (
          <HeaderButton
            label="Add a memory"
            onPress={() => {
              haptics.tap();
              router.push(newMemoryHref(teammateId));
            }}
            testID="new-memory"
          >
            <Plus size={24} color={colors.foreground} />
          </HeaderButton>
        ),
      }}
    />
  );

  const top = (
    <View style={styles.top}>
      <ConnectionNotice />
      <View style={styles.inset}>
        <TextField
          value={text}
          onChangeText={setText}
          placeholder="Search memories"
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Search memories"
          testID="memory-search"
          trailing={
            searching && text.trim() ? (
              <ActivityIndicator size={16} color={colors.mutedForeground} style={styles.icon} />
            ) : text ? (
              <Pressable
                onPress={() => setText("")}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Clear the search"
                style={styles.icon}
                testID="memory-search-clear"
              >
                <X size={18} color={colors.mutedForeground} />
              </Pressable>
            ) : (
              <View style={styles.icon}>
                <Search size={18} color={colors.mutedForeground} />
              </View>
            )
          }
        />
      </View>
      {scopes.length > 1 && <FilterChips options={scopes} value={scope} onChange={setScope} />}
      <Text variant="small" muted style={[styles.inset, styles.about]}>
        {teammate
          ? `${teammate.name}'s own facts and lessons. Suggestions count once you confirm them.`
          : "Facts and preferences every teammate can use. Suggestions count once you confirm them."}
      </Text>
    </View>
  );

  // Loading or failing shows in the list, under the search and chips, so you can always switch.
  const body = memoryListBody(memories);
  const empty =
    body === "loading" ? (
      <Loading />
    ) : body === "error" ? (
      <LoadError
        title="Couldn't load memory"
        error={memories.error}
        onRetry={() => void memories.refetch()}
      />
    ) : (
      <Empty
        icon={<Brain size={28} color={colors.mutedForeground} />}
        title={query ? "Nothing matches" : "Nothing saved yet"}
        body={
          query
            ? "No memories match that search."
            : "Add a fact, or ask a teammate to remember something."
        }
      />
    );

  return (
    <View style={{ flex: 1 }} testID="memory-screen">
      {header}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
        style={searching ? { opacity: 0.6 } : undefined}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListHeaderComponent={top}
        ListEmptyComponent={empty}
        ListFooterComponent={
          items.length >= MEMORY_LIST_LIMIT ? (
            <Text variant="caption" muted style={styles.footer}>
              Showing the newest {MEMORY_LIST_LIMIT} memories. Search to find older ones.
            </Text>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <View
            style={[
              styles.cell,
              { backgroundColor: colors.surface, borderColor: colors.border },
              index === 0 && styles.firstCell,
              index === items.length - 1 && styles.lastCell,
            ]}
          >
            <MemoryRow
              item={item}
              savedBy={savedBy(item.source.teammateId)}
              first={index === 0}
              onPress={() => router.push(memoryHref(item.id))}
            />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space(4), flexGrow: 1 },
  // The chips bring their own side padding; the list's is taken back so they line up.
  top: {
    marginHorizontal: -space(4),
    gap: space(1),
    paddingTop: space(3),
    paddingBottom: space(3),
  },
  inset: { marginHorizontal: space(4) },
  about: { paddingHorizontal: space(1) },
  icon: { width: 44, alignItems: "center", justifyContent: "center" },
  cell: { borderLeftWidth: 1, borderRightWidth: 1, overflow: "hidden" },
  firstCell: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  lastCell: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  footer: { textAlign: "center", paddingVertical: space(4) },
});
