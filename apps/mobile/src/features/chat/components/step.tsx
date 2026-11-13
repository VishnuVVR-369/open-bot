import { ChevronRight } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { CodeScroll } from "@/components/code-scroll";
import { Text } from "@/components/text";
import { animateLayout } from "@/lib/motion";
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
        onPress={() => {
          animateLayout();
          setOpen((value) => !value);
        }}
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

/** The most lines of output shown before "Show all". */
const OUTPUT_LINES = 14;

/** Output or a diff, in a mono block whose long lines scroll sideways; long output folds. */
export function CodeBlock({ children }: { children: string }) {
  const lines = children.split("\n");
  const [all, setAll] = useState(false);
  const long = lines.length > OUTPUT_LINES + 2;
  const shown = long && !all ? lines.slice(0, OUTPUT_LINES).join("\n") : children;
  return (
    <View style={{ gap: space(1) }}>
      <CodeScroll copyText={children}>
        <Text variant="mono" style={{ fontSize: 12, lineHeight: 18 }} selectable>
          {shown}
        </Text>
      </CodeScroll>
      {long && (
        <Pressable
          onPress={() => {
            animateLayout();
            setAll((value) => !value);
          }}
          accessibilityRole="button"
          style={styles.more}
          hitSlop={8}
        >
          <Text variant="small" muted style={{ textDecorationLine: "underline" }}>
            {all ? "Show less" : `Show all ${lines.length} lines`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: space(2) },
  icon: { width: 16, alignItems: "center" },
  summary: { flex: 1 },
  detail: { marginLeft: space(6), marginTop: space(1), marginBottom: space(2) },
  more: { minHeight: 32, justifyContent: "center", alignSelf: "flex-start" },
});
