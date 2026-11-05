import type { PageSummary } from "@open-bot/api";
import { FileText } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { ConnectionNotice } from "@/components/connection-notice";
import { PageMenu, PageRow } from "@/components/page-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { sortPages } from "@/lib/pages";
import { usePages, useTeammates } from "@/lib/queries";
import { radius, space, useColors } from "@/theme";

/** Every page teammates have published, pinned first. Hold one to pin or delete it. */
export default function PagesScreen() {
  const colors = useColors();
  const pages = usePages();
  const teammates = useTeammates();
  const [menuFor, setMenuFor] = useState<PageSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([pages.refetch(), teammates.refetch()]);
    setRefreshing(false);
  }, [pages, teammates]);
  const sorted = useMemo(() => sortPages(pages.data ?? []), [pages.data]);
  const bots = teammates.data ?? [];

  if (pages.isLoading) return <Loading />;
  if (pages.error && !pages.data)
    return <LoadError error={pages.error} onRetry={() => void pages.refetch()} />;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={sorted}
        keyExtractor={(page) => page.id}
        ListHeaderComponent={<ConnectionNotice />}
        contentContainerStyle={[styles.content, sorted.length === 0 && { flexGrow: 1 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListEmptyComponent={
          <Empty
            icon={<FileText size={28} color={colors.mutedForeground} />}
            title="No pages yet"
            body="Ask a teammate for one in any chat, like “Read this post and make a page explaining the system design”. You can also share a link into open-bot from another app."
          />
        }
        renderItem={({ item: page, index }) => (
          <View
            style={[
              styles.cell,
              { backgroundColor: colors.surface, borderColor: colors.border },
              index === 0 && styles.firstCell,
              index === sorted.length - 1 && styles.lastCell,
            ]}
          >
            <PageRow
              page={page}
              bot={bots.find((bot) => bot.id === page.botId)}
              first={index === 0}
              onLongPress={() => setMenuFor(page)}
            />
          </View>
        )}
        ListFooterComponent={
          sorted.length > 0 ? (
            <Text variant="caption" muted style={styles.footer}>
              Hold a page to pin or delete it.
            </Text>
          ) : undefined
        }
        testID="pages"
      />
      <PageMenu page={menuFor} onClose={() => setMenuFor(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(2), paddingBottom: space(10) },
  // The list is one card, drawn a row at a time so it stays virtualized.
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
  footer: { textAlign: "center", marginTop: space(4) },
});
