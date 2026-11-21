import { describeEgress } from "@open-bot/api";
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import {
  Dot,
  PathIcon,
  pathTone,
  toneColor,
} from "@/features/settings/components/phone-connection-parts";
import { useEgressStatus } from "@/features/settings/hooks";
import { radius, space, useColors } from "@/theme";

/**
 * Where teammates' browser goes online: through your Mac, your phone, straight from the cloud, or
 * waiting for your phone. Tapping it opens the phone connection.
 */
export function PathChip() {
  const colors = useColors();
  const { data } = useEgressStatus();
  if (!data?.computerConnected) return null;
  const { label, detail } = describeEgress(data);
  return (
    <Pressable
      onPress={() => router.push("/phone-connection")}
      android_ripple={{ color: colors.muted }}
      style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      testID="egress-path"
    >
      <PathIcon path={data.path} size={16} color={colors.mutedForeground} />
      <View style={styles.text}>
        <Text variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" muted numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Dot color={toneColor(pathTone(data.path), colors)} />
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    minHeight: 44,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
    borderRadius: radius.xl + 2,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: "hidden",
  },
  text: { flex: 1, gap: 1 },
});
