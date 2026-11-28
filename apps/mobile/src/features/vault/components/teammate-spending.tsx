import { router } from "expo-router";
import { ChevronRight, Wallet } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { budgetHref } from "../vault";

/**
 * A teammate's way to their budget and purchases. It says nothing of them here: they're in the
 * vault, behind your fingerprint.
 */
export function TeammateSpending({ teammateId, name }: { teammateId: string; name: string }) {
  const colors = useColors();
  return (
    <Section title="Spending">
      <Card>
        <Pressable
          onPress={() => {
            haptics.tap();
            router.push(budgetHref(teammateId));
          }}
          accessibilityRole="button"
          android_ripple={{ color: colors.muted }}
          style={styles.row}
          testID="profile-budget"
        >
          <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
            <Wallet size={18} color={colors.foreground} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">Budget and purchases</Text>
            <Text variant="small" muted numberOfLines={2}>
              What {name} may spend from the vault's cards. Opens with your fingerprint.
            </Text>
          </View>
          <ChevronRight size={18} color={colors.mutedForeground} />
        </Pressable>
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
