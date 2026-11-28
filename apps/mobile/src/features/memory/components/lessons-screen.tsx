import { router, Stack, useLocalSearchParams } from "expo-router";
import { GraduationCap } from "lucide-react-native";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { useTeammates } from "@/features/teammates/hooks";
import { haptics } from "@/lib/haptics";
import { ago } from "@/lib/time";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { useLessons } from "../hooks";
import { memoryHref } from "../memory";

/**
 * What a teammate learned from your feedback, newest first. They read these before every task;
 * each is a memory, so it opens to edit or forget.
 */
export default function LessonsScreen() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const { teammateId } = useLocalSearchParams<{ teammateId: string }>();
  const lessons = useLessons(teammateId);
  const { data: teammates } = useTeammates();
  const name = teammates?.find((teammate) => teammate.id === teammateId)?.name;
  const { refreshing, onRefresh } = usePullToRefresh(() => lessons.refetch());
  const items = lessons.data ?? [];
  const title = <Stack.Screen options={{ title: name ? `${name}'s lessons` : "Lessons" }} />;

  if (lessons.isLoading)
    return (
      <>
        {title}
        <Loading />
      </>
    );
  if (lessons.error && !lessons.data)
    return (
      <>
        {title}
        <LoadError
          title="Couldn't load the lessons"
          error={lessons.error}
          onRetry={() => void lessons.refetch()}
          onBack={() => router.back()}
        />
      </>
    );

  return (
    <View style={{ flex: 1 }}>
      {title}
      <FlatList
        data={items}
        keyExtractor={(lesson) => lesson.id}
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
          items.length > 0 ? (
            <Text variant="small" muted style={styles.about}>
              {name ? `${name} reads these before every task.` : "Read before every task."}
            </Text>
          ) : undefined
        }
        ListEmptyComponent={
          <Empty
            icon={<GraduationCap size={28} color={colors.mutedForeground} />}
            title="No lessons yet"
            body={`Give ${name ?? "them"} feedback on a reply and ask them to remember it, and it shows up here.`}
          />
        }
        renderItem={({ item: lesson, index }) => (
          <Pressable
            onPress={() => {
              haptics.tap();
              router.push(memoryHref(lesson.id));
            }}
            accessibilityRole="button"
            accessibilityHint="Opens the lesson to edit or forget it"
            android_ripple={{ color: colors.muted }}
            style={[
              styles.row,
              { backgroundColor: colors.surface, borderColor: colors.border },
              index === 0 && styles.first,
              index === items.length - 1 && styles.last,
              index > 0 && { borderTopWidth: StyleSheet.hairlineWidth },
            ]}
            testID="lesson-row"
          >
            <Text numberOfLines={4}>{lesson.text}</Text>
            <Text variant="caption" muted>
              {ago(lesson.createdAt)}
            </Text>
          </Pressable>
        )}
        testID="lessons"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), flexGrow: 1 },
  about: { paddingHorizontal: space(1), paddingBottom: space(3) },
  row: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    gap: space(1),
    overflow: "hidden",
  },
  first: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  last: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
});
