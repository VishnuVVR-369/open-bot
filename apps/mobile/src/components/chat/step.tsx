import { ChevronRight } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

export type StepIcon = (props: { size: number; color: string }) => ReactNode;

/** A step a teammate took: an icon, a one-line summary, and detail you can open. */
export function Step({
  icon: Icon,
  summary,
  detail,
  running,
  failed,
  mono,
}: {
  icon: StepIcon;
  summary: string;
  detail?: ReactNode;
  running?: boolean;
  failed?: boolean;
  mono?: boolean;
}) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const color = failed ? colors.destructive : colors.mutedForeground;
  return (
    <View>
      <Pressable
        disabled={!detail}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole={detail ? "button" : undefined}
        accessibilityState={detail ? { expanded: open } : undefined}
        style={styles.row}
        hitSlop={4}
      >
        <View style={styles.icon}>
          {running ? (
            <ActivityIndicator size={12} color={colors.mutedForeground} />
          ) : (
            <Icon size={14} color={color} />
          )}
        </View>
        <Text
          variant={mono ? "mono" : "small"}
          numberOfLines={1}
          style={[styles.summary, { color }, mono && { fontSize: 12.5 }]}
        >
          {summary}
        </Text>
        {detail && (
          <ChevronRight
            size={14}
            color={colors.mutedForeground}
            style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
          />
        )}
      </Pressable>
      {open && detail && <View style={styles.detail}>{detail}</View>}
    </View>
  );
}

/** Output or a diff, in a scrollable mono block. */
export function CodeBlock({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.code, { backgroundColor: colors.subtle }]}>
      <Text variant="mono" style={{ fontSize: 12, lineHeight: 18 }} selectable>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: space(2) },
  icon: { width: 16, alignItems: "center" },
  summary: { flex: 1 },
  detail: { marginLeft: space(6), marginTop: space(1), marginBottom: space(2) },
  code: { borderRadius: 8, paddingHorizontal: space(3), paddingVertical: space(2) },
});
