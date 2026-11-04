import type { MessageView } from "@open-bot/api";
import { fileKind } from "@open-bot/shared";
import { RotateCcw } from "lucide-react-native";
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { FileChip } from "@/components/file-chip";
import { ImageThumb } from "@/components/image-thumb";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

/** Your message: ink on the right, like the web (a softer grey in the dark). */
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
          {message.attachments.map((file) =>
            fileKind(file.name) === "image" ? (
              <ImageThumb key={file.path} path={file.path} name={file.name} />
            ) : (
              <FileChip key={file.path} path={file.path} name={file.name} />
            ),
          )}
        </View>
      )}
      {message.text ? (
        <View style={[styles.bubble, { backgroundColor: colors.bubble }]}>
          <Text
            style={{ color: colors.bubbleForeground, fontSize: 15.5, lineHeight: 22 }}
            selectable
          >
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
  bubble: {
    maxWidth: "85%",
    borderRadius: 20,
    borderBottomRightRadius: 6,
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
  },
});
