import * as Clipboard from "expo-clipboard";
import { RECOVERY_COPY } from "@open-bot/shared";
import { Check, Copy } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";

/** A command to run somewhere else, in full, with a Copy button that says when it worked. */
export function CopyCommand({ command, testID }: { command: string; testID?: string }) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View
      style={[styles.box, { backgroundColor: colors.subtle, borderColor: colors.border }]}
      testID={testID}
    >
      <Text variant="mono" selectable style={styles.command}>
        {command}
      </Text>
      <Pressable
        onPress={() => {
          void Clipboard.setStringAsync(command);
          haptics.success();
          setCopied(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={
          copied ? RECOVERY_COPY.copied : `${RECOVERY_COPY.copyAction} the command`
        }
        android_ripple={{ color: colors.muted }}
        style={[styles.copy, { backgroundColor: colors.surface, borderColor: colors.input }]}
        testID={testID ? `${testID}-copy` : undefined}
      >
        {copied ? (
          <Check size={14} color={colors.done} />
        ) : (
          <Copy size={14} color={colors.foreground} />
        )}
        <Text variant="small" style={{ fontWeight: "600" }}>
          {copied ? RECOVERY_COPY.copied : RECOVERY_COPY.copyAction}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: radius.lg,
    paddingLeft: space(3),
    paddingRight: space(1.5),
    paddingVertical: space(1.5),
  },
  command: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  copy: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    minHeight: 36,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space(3),
    overflow: "hidden",
  },
});
