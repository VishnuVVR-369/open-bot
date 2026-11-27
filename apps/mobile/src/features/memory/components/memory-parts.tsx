import { MEMORY_KIND_LABELS, MEMORY_KINDS, type MemoryKind } from "@open-bot/domain";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";

/** What kind of memory it is, as one control with the four kinds. */
export function KindPicker({
  value,
  onChange,
  disabled,
}: {
  value: MemoryKind;
  onChange: (kind: MemoryKind) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.track, { backgroundColor: colors.subtle, borderColor: colors.border }]}
      accessibilityRole="radiogroup"
      accessibilityLabel="Type"
    >
      {MEMORY_KINDS.map((kind) => {
        const selected = kind === value;
        return (
          <Pressable
            key={kind}
            onPress={() => {
              if (selected || disabled) return;
              haptics.tap();
              onChange(kind);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={MEMORY_KIND_LABELS[kind]}
            style={[
              styles.segment,
              selected && { backgroundColor: colors.surface, borderColor: colors.input },
            ]}
            testID={`memory-kind-${kind}`}
          >
            <Text
              variant="small"
              numberOfLines={1}
              style={{
                fontWeight: selected ? "600" : "500",
                color: selected ? colors.foreground : colors.mutedForeground,
              }}
            >
              {MEMORY_KIND_LABELS[kind]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A labelled part of a form. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="overline" muted style={{ paddingHorizontal: space(1) }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

/** A quiet box with a short message, like "This memory was forgotten". */
export function Notice({
  children,
  action,
  tone = "quiet",
  testID,
}: {
  children: string;
  action?: ReactNode;
  tone?: "quiet" | "attention";
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.notice,
        tone === "attention"
          ? { backgroundColor: colors.surface, borderColor: colors.attention }
          : { backgroundColor: colors.subtle, borderColor: colors.subtle },
      ]}
      testID={testID}
    >
      <Text
        variant="small"
        style={[
          { flex: 1 },
          tone === "attention" ? { color: colors.attentionInk } : { color: colors.mutedForeground },
        ]}
      >
        {children}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space(1),
    borderRadius: radius.xl - 3,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: "transparent",
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
});
