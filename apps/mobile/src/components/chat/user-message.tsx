import type { MessageView } from "@open-bot/api";
import { Paperclip, RotateCcw } from "lucide-react-native";
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

/** Your message: ink on the right, like the web. */
export const UserMessage = memo(function UserMessage({ message }: { message: MessageView }) {
  const colors = useColors();
  return (
    <View style={styles.wrap} testID="user-message">
      {message.redoOfRunId && (
        <View style={styles.row}>
          <RotateCcw size={12} color={colors.mutedForeground} />
          <Text variant="caption" muted>
            Asked to try again
          </Text>
        </View>
      )}
      {message.attachments.length > 0 && (
        <View style={styles.files}>
          {message.attachments.map((file) => (
            <View
              key={file.path}
              style={[styles.file, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <Paperclip size={13} color={colors.mutedForeground} />
              <Text variant="caption" numberOfLines={1}>
                {file.name}
              </Text>
            </View>
          ))}
        </View>
      )}
      {message.text ? (
        <View style={[styles.bubble, { backgroundColor: colors.foreground }]}>
          <Text style={{ color: colors.background, fontSize: 15 }} selectable>
            {message.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end", gap: space(1.5) },
  row: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  files: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space(1.5) },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1.5),
    maxWidth: 240,
  },
  bubble: {
    maxWidth: "85%",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2),
  },
});
