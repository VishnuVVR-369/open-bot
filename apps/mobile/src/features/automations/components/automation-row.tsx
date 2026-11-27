import type { TeammateSummary } from "@open-bot/api";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { Toggle } from "@/components/toggle";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { space, useColors } from "@/theme";
import { setAutomationEnabled } from "../actions";
import {
  automationHref,
  canTurnOn,
  lastLine,
  stateBadge,
  keepPartsWhole,
  whenLine,
  type Automation,
} from "../automations";
import { AutomationAvatar, StateBadge } from "./automation-parts";

/**
 * An automation in a list: who runs it and what kind it is, its name, when it runs or what it
 * watches, how it went last, and its switch. Tapping it opens it, with its history.
 */
export function AutomationRow({
  automation,
  teammate,
  computerOnline,
  first,
  compact = false,
}: {
  automation: Automation;
  teammate: TeammateSummary | undefined;
  computerOnline: boolean;
  first: boolean;
  /** A shorter row under the title, for a profile's short list. */
  compact?: boolean;
}) {
  const colors = useColors();
  const online = useOnline();
  const badge = stateBadge(automation);
  const last = compact ? null : lastLine(automation);
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push(automationHref(automation));
      }}
      accessibilityRole="button"
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID={`automation-row-${automation.id}`}
    >
      <AutomationAvatar automation={automation} teammate={teammate} size={compact ? "md" : "lg"} />
      <View style={styles.text}>
        <View style={styles.titleRow}>
          <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {automation.title}
          </Text>
          {badge && <StateBadge label={badge} />}
        </View>
        {/* All of it in the full list: cut short, it drops "tells you only if…" or a zone. A
            profile's short list keeps two lines, enough for the cadence and the next run. */}
        <Text variant="small" muted numberOfLines={compact ? 2 : undefined}>
          {keepPartsWhole(whenLine(automation, { computerOnline }))}
        </Text>
        {last && (
          <Text
            variant="caption"
            numberOfLines={2}
            style={{ color: last.failed ? colors.destructive : colors.mutedForeground }}
          >
            {keepPartsWhole(last.text)}
          </Text>
        )}
      </View>
      {canTurnOn(automation) && (
        <Toggle
          value={automation.enabled}
          onValueChange={(enabled) => void setAutomationEnabled(automation, enabled)}
          disabled={!online}
          accessibilityLabel={`${automation.title} on`}
          testID={`automation-toggle-${automation.id}`}
        />
      )}
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
    minHeight: 64,
  },
  text: { flex: 1, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
