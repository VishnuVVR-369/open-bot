import type { PageItem } from "@open-bot/shared";
import { router } from "expo-router";
import { ArrowUpRight } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { PageThumb } from "@/components/page-thumb";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { pageHref } from "@/lib/pages";
import { radius, space, useColors } from "@/theme";

/** A page the teammate published in this turn. Opens the version it published. */
export function PageCard({ item }: { item: PageItem }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push(pageHref(item.pageId, item.versionId));
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open the page ${item.title}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: pressed ? colors.input : colors.border,
          opacity: pressed ? 0.92 : 1,
        },
      ]}
      testID="page-card"
    >
      <PageThumb
        versionId={item.versionId}
        style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
      />
      <View style={styles.body}>
        <Text variant="caption" muted style={styles.eyebrow}>
          {item.version === 1 ? "NEW PAGE" : `PAGE · VERSION ${item.version}`}
        </Text>
        <Text variant="heading" numberOfLines={2} style={{ fontSize: 16, lineHeight: 21 }}>
          {item.title}
        </Text>
        {item.summary ? (
          <Text variant="small" muted numberOfLines={2}>
            {item.summary}
          </Text>
        ) : null}
        <View style={styles.open}>
          <Text variant="small" style={{ fontWeight: "500" }}>
            Open page
          </Text>
          <ArrowUpRight size={14} color={colors.foreground} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
  body: { paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(3.5), gap: 4 },
  eyebrow: { letterSpacing: 0.6, fontWeight: "500", fontSize: 11 },
  open: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: space(1.5) },
});
