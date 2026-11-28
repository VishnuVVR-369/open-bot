import { isSuggestion, MEMORY_LIST_LIMIT } from "@open-bot/domain";
import { router } from "expo-router";
import { Brain, ChevronRight, GraduationCap } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ListRow } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { useColors } from "@/theme";
import { useLessons, useMemories } from "../hooks";
import { lessonsHref, memoryCount, memoryListHref } from "../memory";

/** A teammate's memory and lessons on their profile, each opening its own list. */
export function TeammateMemory({ teammateId, name }: { teammateId: string; name: string }) {
  const colors = useColors();
  const memories = useMemories(teammateId, "");
  const lessons = useLessons(teammateId);
  const items = memories.data;
  const suggestions = items?.filter(isSuggestion).length ?? 0;
  const lessonCount = lessons.data?.length;
  const latest = lessons.data?.[0]?.text;
  return (
    <Section title="Memory">
      <Card>
        <ListRow
          leading={<Icon>{<Brain size={18} color={colors.foreground} />}</Icon>}
          title="Memory"
          subtitle={
            items === undefined
              ? `What ${name} remembers`
              : [
                  memoryCount(items.length, MEMORY_LIST_LIMIT),
                  suggestions > 0
                    ? `${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"} to confirm`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
          aside={<ChevronRight size={18} color={colors.mutedForeground} />}
          onPress={() => router.push(memoryListHref(teammateId))}
          testID="profile-memory"
        />
        <View style={[styles.divided, { borderTopColor: colors.border }]}>
          <ListRow
            leading={<Icon>{<GraduationCap size={18} color={colors.foreground} />}</Icon>}
            title={
              lessonCount ? `${lessonCount} ${lessonCount === 1 ? "lesson" : "lessons"}` : "Lessons"
            }
            subtitle={
              latest ? (
                <Text variant="small" muted numberOfLines={2}>
                  {latest}
                </Text>
              ) : lessonCount === 0 ? (
                "None yet. Feedback on a reply can teach them."
              ) : (
                "What they learned from your feedback"
              )
            }
            aside={<ChevronRight size={18} color={colors.mutedForeground} />}
            onPress={() => router.push(lessonsHref(teammateId))}
            testID="profile-lessons"
          />
        </View>
      </Card>
    </Section>
  );
}

function Icon({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <View style={[styles.icon, { backgroundColor: colors.subtle }]}>{children}</View>;
}

const styles = StyleSheet.create({
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
