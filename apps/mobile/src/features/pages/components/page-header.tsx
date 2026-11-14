import { ChevronDown, EllipsisVertical, MessageSquare } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

/** The page's title and who made it; with more than one version, a tap shows them. */
export function PageTitle({
  title,
  subtitle,
  hasVersions,
  onVersions,
}: {
  title: string;
  subtitle: string;
  hasVersions: boolean;
  onVersions: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => hasVersions && onVersions()}
      disabled={!hasVersions}
      accessibilityRole={hasVersions ? "button" : undefined}
      accessibilityHint={hasVersions ? "Shows its versions" : undefined}
      style={styles.headerTitle}
      testID="page-header"
    >
      <Text variant="heading" numberOfLines={1} style={{ fontSize: 16, lineHeight: 20 }}>
        {title}
      </Text>
      <View style={styles.headerMeta}>
        <Text variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
          {subtitle}
        </Text>
        {hasVersions && <ChevronDown size={12} color={colors.mutedForeground} />}
      </View>
    </Pressable>
  );
}

/** Ask about the page, when its teammate is still around, and the page's options. */
export function PageActions({
  askName,
  onAsk,
  onMenu,
}: {
  /** Who a question goes to, or null when nobody can answer one. */
  askName: string | null;
  onAsk: () => void;
  onMenu: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.headerActions}>
      {askName !== null && (
        <Pressable
          onPress={onAsk}
          accessibilityRole="button"
          accessibilityLabel={`Ask ${askName} about this page`}
          android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
          style={styles.headerButton}
          testID="page-ask-open"
        >
          <MessageSquare size={21} color={colors.foreground} />
        </Pressable>
      )}
      <Pressable
        onPress={onMenu}
        accessibilityRole="button"
        accessibilityLabel="Page options"
        android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
        style={styles.headerButton}
        testID="page-menu-open"
      >
        <EllipsisVertical size={22} color={colors.foreground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { maxWidth: 240, gap: 1 },
  headerMeta: { flexDirection: "row", alignItems: "center", gap: 3 },
  headerActions: { flexDirection: "row", alignItems: "center", marginRight: -space(2) },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
