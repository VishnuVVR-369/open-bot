import { router } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { useRunMemory } from "../hooks";
import { memoryHref, runMemoryText } from "../memory";

/**
 * The saved memories a reply was given, as they were then. One changed or forgotten since says so
 * instead of showing words it no longer has; the rest open to read or edit.
 */
export function RunMemorySheet({
  runId,
  open,
  onClose,
}: {
  runId: string;
  open: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const { data, error } = useRunMemory(runId, open);
  return (
    <Sheet open={open} onClose={onClose} title="Memories given to this reply" testID="run-memory">
      <ScrollView style={styles.list} contentContainerStyle={styles.content}>
        {error ? (
          <Text variant="small" muted>
            {errorMessage(error, "Couldn't load what it remembered.")}
          </Text>
        ) : !data ? (
          <ActivityIndicator color={colors.mutedForeground} style={{ alignSelf: "flex-start" }} />
        ) : data.length === 0 ? (
          <Text variant="small" muted>
            No saved memories were given to this reply.
          </Text>
        ) : (
          data.map((ref) => {
            const { text, faded } = runMemoryText(ref);
            return (
              <Pressable
                key={`${ref.id}@${ref.revision}`}
                disabled={ref.forgotten}
                onPress={() => {
                  haptics.tap();
                  onClose();
                  router.push(memoryHref(ref.id));
                }}
                accessibilityRole="button"
                android_ripple={{ color: colors.muted }}
                style={styles.row}
                testID="run-memory-row"
              >
                <View style={[styles.mark, { backgroundColor: colors.mutedForeground }]} />
                <Text
                  variant="small"
                  muted={faded}
                  style={[{ flex: 1 }, faded && { fontStyle: "italic" }]}
                >
                  {text}
                </Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 360 },
  content: { paddingHorizontal: space(5), paddingBottom: space(2), gap: space(1) },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingVertical: space(2),
  },
  mark: { width: 4, height: 4, borderRadius: 2, marginTop: 8 },
});
