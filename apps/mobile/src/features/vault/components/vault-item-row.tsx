import type { VaultItemView } from "@open-bot/api";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { fonts, space, useColors } from "@/theme";
import { cardFace, itemDetails } from "../vault";

/** Each brand's color, as the web's card faces use it. */
const BRAND_COLOR: Record<string, string> = {
  Visa: "#1f2a86",
  Mastercard: "#3a3a3a",
  Amex: "#2378c4",
  Discover: "#e0712b",
};

/** A small card face: the brand and its last four digits. */
export function CardFace({ hint }: { hint: string }) {
  const { brand, last4 } = cardFace(hint);
  return (
    <View
      style={[styles.face, { backgroundColor: BRAND_COLOR[brand] ?? "#5b5b63" }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text allowFontScaling={false} style={styles.brand}>
        {brand.toUpperCase()}
      </Text>
      <Text allowFontScaling={false} style={styles.last4}>
        •• {last4}
      </Text>
    </View>
  );
}

/** A login or card in the vault: what it is and who may use it. Opens it to edit. */
export function VaultItemRow({
  item,
  teammates,
  first,
  onPress,
}: {
  item: VaultItemView;
  teammates: readonly { id: string; name: string }[];
  first: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const details = itemDetails(item, teammates);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${details.join(", ")}`}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID={`vault-item-${item.id}`}
    >
      {item.kind === "card" ? (
        <CardFace hint={item.hint} />
      ) : (
        <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
          <KeyRound size={18} color={colors.foreground} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" numberOfLines={1}>
          {item.name}
        </Text>
        <Text variant="small" muted numberOfLines={2}>
          {details.join(" · ")}
        </Text>
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 68,
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  face: {
    width: 56,
    height: 36,
    borderRadius: 7,
    paddingHorizontal: 6,
    paddingVertical: 4,
    justifyContent: "space-between",
  },
  brand: {
    color: "#ffffff",
    fontFamily: fonts.sans,
    fontSize: 8.5,
    lineHeight: 10,
    fontWeight: "600",
    letterSpacing: 0.4,
    opacity: 0.9,
  },
  last4: { color: "#ffffff", fontFamily: fonts.mono, fontSize: 10, lineHeight: 12 },
});
