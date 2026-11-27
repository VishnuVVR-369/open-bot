import type { MemoryRevision } from "@open-bot/domain";
import { router, useLocalSearchParams } from "expo-router";
import { Brain, History } from "lucide-react-native";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Card } from "@/components/section";
import { Empty, LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { isNotFound } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { useOnline } from "@/lib/network";
import { ago } from "@/lib/time";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { space, useColors } from "@/theme";
import { restoreRevision } from "../actions";
import { useMemory, useMemoryHistory } from "../hooks";
import { historyScreenState, memoryListHref, revisionSource } from "../memory";
import { Notice } from "./memory-parts";

/**
 * Every revision of a memory, newest first. Restoring an earlier one saves it again as the newest,
 * so nothing is lost; it names the revision you saw, so a change made meanwhile is refused.
 */
export default function MemoryHistoryScreen() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const online = useOnline();
  const { memoryId } = useLocalSearchParams<{ memoryId: string }>();
  const memory = useMemory(memoryId);
  const history = useMemoryHistory(memoryId);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [result, setResult] = useState<{ text: string; problem: boolean } | null>(null);
  const { refreshing, onRefresh } = usePullToRefresh(() =>
    Promise.all([memory.refetch(), history.refetch()]),
  );
  // The same rule as the memory's screen: only the server saying it's gone counts as forgotten.
  const state = historyScreenState(memory, history, isNotFound);
  const current = state.kind === "ready" ? state.current : undefined;

  async function restore(revision: number) {
    if (!current) return;
    haptics.tap();
    setRestoring(revision);
    setResult(null);
    const change = await restoreRevision(current, revision);
    setRestoring(null);
    setResult(
      change.ok
        ? { text: `Restored revision ${revision} as the newest.`, problem: false }
        : { text: change.message, problem: true },
    );
  }

  if (state.kind === "loading") return <Loading />;
  if (state.kind === "gone")
    return (
      <NotFound
        icon={Brain}
        title="This memory is gone"
        body="It was forgotten, and its history with it."
        action="Go to Memory"
        onAction={() => router.replace(memoryListHref())}
      />
    );
  if (state.kind === "error")
    return (
      <LoadError
        title="Couldn't load the history"
        error={state.error}
        onRetry={() => void onRefresh()}
        onBack={() => router.back()}
      />
    );

  return (
    <FlatList
      data={state.revisions}
      keyExtractor={(revision) => String(revision.revision)}
      contentContainerStyle={[styles.content, { paddingBottom: bottom + space(4) }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      ListHeaderComponent={
        <View style={styles.head}>
          <Text variant="small" muted style={styles.inset}>
            Restoring a revision saves it again as the newest. Forgetting a memory removes its
            history too.
          </Text>
          {result && (
            <Notice tone={result.problem ? "attention" : "quiet"} testID="restore-result">
              {result.text}
            </Notice>
          )}
        </View>
      }
      ListEmptyComponent={
        <Empty
          icon={<History size={28} color={colors.mutedForeground} />}
          title="No history"
          body="This memory has no saved revisions."
        />
      }
      renderItem={({ item: revision }) => (
        <Version
          revision={revision}
          current={revision.revision === current?.revision}
          busy={restoring === revision.revision}
          disabled={!online || restoring !== null || !current}
          onRestore={() => void restore(revision.revision)}
        />
      )}
      ItemSeparatorComponent={() => <View style={{ height: space(3) }} />}
      testID="memory-history-list"
    />
  );
}

function Version({
  revision,
  current,
  busy,
  disabled,
  onRestore,
}: {
  revision: MemoryRevision;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onRestore: () => void;
}) {
  const colors = useColors();
  const { chatId, runId } = revision.source;
  return (
    <Card>
      <View style={styles.version} testID={`revision-${revision.revision}`}>
        <Text variant="caption" muted>
          {[
            `Revision ${revision.revision}`,
            current ? "Current" : null,
            revisionSource(revision),
            ago(revision.createdAt),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <Text selectable>{revision.content}</Text>
        {chatId && (
          <Pressable
            onPress={() => {
              haptics.tap();
              router.push(chatHref(chatId, runId));
            }}
            accessibilityRole="link"
            hitSlop={8}
            style={styles.link}
          >
            <Text
              variant="small"
              style={{ color: colors.foreground, textDecorationLine: "underline" }}
            >
              See the conversation
            </Text>
          </Pressable>
        )}
        {!current && (
          <Button
            title={`Restore revision ${revision.revision}`}
            variant="outline"
            onPress={onRestore}
            disabled={disabled}
            busy={busy}
            testID={`restore-${revision.revision}`}
          />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), flexGrow: 1 },
  head: { gap: space(3), paddingBottom: space(4) },
  inset: { paddingHorizontal: space(1) },
  version: { padding: space(4), gap: space(2.5) },
  link: { alignSelf: "flex-start" },
});
