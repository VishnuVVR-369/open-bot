import type { TeammateSummary } from "@open-bot/api";
import { dailyCheckInOn, isDailyCheckIn } from "@open-bot/domain";
import { router } from "expo-router";
import { Sunrise } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { Toggle } from "@/components/toggle";
import { useComputerOffline } from "@/features/computer/hooks";
import { SeeAll } from "@/features/home/components/see-all";
import { useOnline } from "@/lib/network";
import { space, useColors } from "@/theme";
import { setDailyCheckIn } from "../actions";
import { automationsHref } from "../automations";
import { useAutomationSections, useSchedules } from "../hooks";
import { AutomationRow } from "./automation-row";

/** How many of a teammate's automations their profile lists before "All". */
const SHOWN = 4;

/**
 * A teammate's automations on their profile, as the web's Automations tab has them: their daily
 * check-in first, then what they run on their own, with the way to all of them.
 */
export function AutomationSection({ teammate }: { teammate: TeammateSummary }) {
  const { sections } = useAutomationSections(teammate.id);
  const computerOffline = useComputerOffline();
  if (!sections) return null;
  // The check-in is the switch above, so it isn't listed again under it.
  const theirs = sections
    .flatMap((section) => section.items)
    .filter((automation) => automation.type !== "schedule" || !isDailyCheckIn(automation));
  return (
    <View testID="profile-automations">
      <Section
        title="Automations"
        action={
          theirs.length > 0 ? (
            <SeeAll
              label={theirs.length > SHOWN ? `All ${theirs.length}` : "All"}
              onPress={() => router.push(automationsHref(teammate.id))}
              testID="profile-automations-all"
            />
          ) : undefined
        }
      >
        <Card>
          <CheckIn teammate={teammate} />
          {theirs.slice(0, SHOWN).map((automation) => (
            <AutomationRow
              key={`${automation.type}-${automation.id}`}
              automation={automation}
              teammate={teammate}
              computerOnline={!computerOffline}
              first={false}
              compact
            />
          ))}
        </Card>
        {theirs.length === 0 && (
          <Text variant="small" muted style={styles.inset}>
            Nothing else runs on its own yet. Set one up in open-bot on a computer, or ask{" "}
            {teammate.name}.
          </Text>
        )}
      </Section>
    </View>
  );
}

/** The daily check-in's switch: every morning at 9 it looks over their area, and speaks up only when something needs you. */
function CheckIn({ teammate }: { teammate: TeammateSummary }) {
  const colors = useColors();
  const online = useOnline();
  const { data: schedules } = useSchedules();
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? dailyCheckInOn(schedules ?? [], teammate.id);
  return (
    <View style={styles.checkIn} testID="check-in">
      <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
        <Sunrise size={18} color={colors.foreground} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label">Daily check-in</Text>
        <Text variant="small" muted>
          Every morning at 9, {teammate.name} looks over their area for deadlines, renewals and
          things waiting on you, and tells you only when something needs you.
        </Text>
      </View>
      <Toggle
        value={on}
        disabled={!online || !schedules || pending !== null}
        accessibilityLabel="Daily check-in"
        onValueChange={async (value) => {
          setPending(value);
          await setDailyCheckIn(teammate.id, value);
          setPending(null);
        }}
        testID="check-in-toggle"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: space(1) },
  checkIn: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
  },
  // The size of the rows' teammate avatars under it, so their text lines up with this one's.
  icon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
});
