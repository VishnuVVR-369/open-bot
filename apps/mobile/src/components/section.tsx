import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

/** A titled group on a page, like the web's uppercase section headings. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text variant="caption" muted style={styles.overline}>
          {title.toUpperCase()}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** A bordered card holding rows. */
export function Card({ children, tint }: { children: ReactNode; tint?: string }) {
  const colors = useColors();
  return (
    <View
      style={[styles.card, { backgroundColor: colors.surface, borderColor: tint ?? colors.border }]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space(2.5) },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 20,
    paddingHorizontal: space(1),
  },
  overline: { letterSpacing: 0.6, fontWeight: "500" },
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
});
