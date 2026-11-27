import type { TeammateSummary } from "@open-bot/api";
import { comingUp, nextRunLabel, runIsHeldBack, WAITING_FOR_COMPUTER } from "@open-bot/domain";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { useComputerOffline } from "@/features/computer/hooks";
import { SeeAll } from "@/features/home/components/see-all";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { AUTOMATIONS_HREF, asSchedule, automationHref } from "../automations";
import { useSchedules } from "../hooks";
import { AutomationAvatar } from "./automation-parts";

/**
 * The next few scheduled runs, as the web's Home shows them, so you know what your teammates will
 * do without asking. Nothing shows while nothing is coming up.
 */
export function ComingUp({ teammates }: { teammates: readonly TeammateSummary[] }) {
  const colors = useColors();
  const { data: schedules } = useSchedules();
  const computerOffline = useComputerOffline();
  const next = comingUp(schedules ?? []);
  if (next.length === 0) return null;
  const now = Date.now();
  return (
    <View testID="home-coming-up">
      <Section
        title="Coming up"
        action={
          <SeeAll
            label="Automations"
            onPress={() => router.push(AUTOMATIONS_HREF)}
            testID="home-automations"
          />
        }
      >
        <Card>
          {next.map((schedule, index) => {
            const teammate = teammates.find((entry) => entry.id === schedule.teammateId);
            return (
              <Pressable
                key={schedule.id}
                onPress={() => {
                  haptics.tap();
                  router.push(automationHref(asSchedule(schedule)));
                }}
                accessibilityRole="button"
                android_ripple={{ color: colors.muted }}
                style={[
                  styles.row,
                  index > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                  },
                ]}
              >
                <AutomationAvatar automation={asSchedule(schedule)} teammate={teammate} size="md" />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label" numberOfLines={1}>
                    {schedule.title}
                  </Text>
                  <Text variant="small" muted numberOfLines={1}>
                    {teammate?.name ?? "Former teammate"}
                  </Text>
                </View>
                <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                  {runIsHeldBack(schedule.nextRunAt!, now, !computerOffline)
                    ? WAITING_FOR_COMPUTER
                    : nextRunLabel(schedule.nextRunAt!)}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 60,
  },
});
