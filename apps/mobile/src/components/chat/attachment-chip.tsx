import { AlertCircle, Paperclip, RotateCcw, X } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import type { PendingFile } from "@/lib/use-attachments";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** A file being attached: its name, how far along it is, and a way to drop (or retry) it. */
export function AttachmentChip({
  pending,
  onRemove,
  onRetry,
}: {
  pending: PendingFile;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const colors = useColors();
  const failed = pending.state === "failed";
  return (
    <View
      style={[
        styles.chip,
        {
          borderColor: failed ? mix(colors.destructive, colors.surface, 0.5) : colors.border,
          backgroundColor: colors.surface,
        },
      ]}
      testID="attachment"
    >
      {failed ? (
        <AlertCircle size={14} color={colors.destructive} />
      ) : pending.state === "uploading" ? (
        <ActivityIndicator size={12} color={colors.mutedForeground} />
      ) : (
        <Paperclip size={14} color={colors.mutedForeground} />
      )}
      <View style={{ flexShrink: 1 }}>
        <Text variant="small" numberOfLines={1} style={{ fontSize: 13.5 }}>
          {pending.file.name}
        </Text>
        {failed ? (
          <Text variant="caption" numberOfLines={1} style={{ color: colors.destructive }}>
            {pending.error}
          </Text>
        ) : pending.state === "uploading" ? (
          <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {Math.round(pending.progress * 100)}%
          </Text>
        ) : null}
      </View>
      {failed && (
        <Pressable onPress={onRetry} hitSlop={8} accessibilityLabel={`Retry ${pending.file.name}`}>
          <RotateCcw size={14} color={colors.foreground} />
        </Pressable>
      )}
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${pending.file.name}`}
      >
        <X size={15} color={colors.mutedForeground} />
      </Pressable>
      {pending.state === "uploading" && (
        <View style={[styles.progress, { backgroundColor: colors.muted }]}>
          <View
            style={{
              width: `${Math.max(4, pending.progress * 100)}%`,
              height: "100%",
              backgroundColor: colors.foreground,
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingLeft: space(2.5),
    paddingRight: space(2),
    minHeight: 44,
    maxWidth: 240,
    overflow: "hidden",
  },
  progress: { position: "absolute", left: 0, right: 0, bottom: 0, height: 2 },
});
