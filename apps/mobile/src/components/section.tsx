import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

/** A titled group on a page, like the web's section headings. */
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
        <Text variant="section" accessibilityRole="header">
          {title}
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
  card: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: radius.xl + 2,
    overflow: "hidden",
  },
});
