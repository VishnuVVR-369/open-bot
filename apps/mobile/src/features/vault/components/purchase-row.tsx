import type { PurchaseView } from "@open-bot/api";
import { formatMoney, PURCHASE_STATUS, purchaseCalledOff } from "@open-bot/domain";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { chatHref } from "@/lib/links";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** A purchase a teammate made or asked to make, with its state; opens the chat it was made in. */
export function PurchaseRow({ purchase, first }: { purchase: PurchaseView; first: boolean }) {
  const colors = useColors();
  const status = PURCHASE_STATUS[purchase.status];
  const pill = {
    attention: { bg: mix(colors.attention, colors.surface, 0.16), fg: colors.attentionInk },
    done: { bg: mix(colors.done, colors.surface, 0.14), fg: colors.done },
    muted: { bg: colors.muted, fg: colors.mutedForeground },
  }[status.tone];
  const off = purchaseCalledOff(purchase.status);
  const meta = [ago(purchase.createdAt), purchase.card, purchase.note].filter(Boolean).join(" · ");
  const chatId = purchase.chatId;
  return (
    <Pressable
      onPress={chatId ? () => router.push(chatHref(chatId, purchase.runId)) : undefined}
      disabled={!chatId}
      accessibilityRole={chatId ? "button" : undefined}
      accessibilityHint={chatId ? "Opens the chat" : undefined}
      android_ripple={chatId ? { color: colors.muted } : undefined}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID={`purchase-${purchase.id}`}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.head}>
          <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {purchase.merchant}
          </Text>
          <View style={[styles.pill, { backgroundColor: pill.bg }]}>
            <Text variant="caption" style={{ color: pill.fg, fontWeight: "600" }}>
              {status.label}
            </Text>
          </View>
        </View>
        <Text variant="small" muted numberOfLines={2}>
          {purchase.description}
        </Text>
        <Text variant="caption" muted numberOfLines={2}>
          {meta}
        </Text>
      </View>
      <Text
        variant="label"
        style={off ? { color: colors.mutedForeground, textDecorationLine: "line-through" } : null}
      >
        {formatMoney(purchase.amountCents)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  head: { flexDirection: "row", alignItems: "center", gap: space(2), flexWrap: "wrap" },
  pill: { borderRadius: 999, paddingHorizontal: space(2), paddingVertical: 2 },
});
