import { Stack, useLocalSearchParams } from "expo-router";
import { CalendarClock, CloudOff } from "lucide-react-native";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { FilterChips } from "@/components/filter-chips";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { ConnectionNotice } from "@/features/computer/components/connection-notice";
import { useComputerOffline } from "@/features/computer/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { useAutomationSections } from "../hooks";
import { AutomationRow } from "./automation-row";

/** How a new automation starts, since the phone doesn't set them up. */
const NEW_NOTE =
  "New automations are set up in open-bot on a computer, or ask a teammate: “Every weekday at 9, send me a briefing.”";

/**
 * Schedules, page watches, mail and calendar triggers, and webhooks, as the web's Automations page
 * lists them: turn each on or off here, and open one for its history, to run it or to rename it.
 */
export default function AutomationsScreen() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const params = useLocalSearchParams<{ teammate?: string }>();
  const [teammateId, setTeammateId] = useState<string | null>(params.teammate ?? null);
  const everyone = useAutomationSections();
  const teammates = useTeammates();
  const computerOffline = useComputerOffline();
  const { refreshing, onRefresh } = usePullToRefresh(() =>
    Promise.all([everyone.refetch(), teammates.refetch()]),
  );
  const allTeammates = useMemo(() => teammates.data ?? [], [teammates.data]);
  // Only the teammates that have any, so every filter shows something.
  const filters = useMemo(() => {
    const owners = new Set(
      (everyone.sections ?? []).flatMap((section) => section.items.map((item) => item.teammateId)),
    );
    return [
      { key: "all", label: "Everyone" },
      ...allTeammates
        .filter((teammate) => owners.has(teammate.id) || teammate.id === teammateId)
        .map((teammate) => ({ key: teammate.id, label: teammate.name })),
    ];
  }, [everyone.sections, allTeammates, teammateId]);

  if (everyone.isLoading) return <Loading />;
  if (everyone.error && !everyone.sections)
    return <LoadError error={everyone.error} onRetry={() => void everyone.refetch()} />;
  const sections = (everyone.sections ?? [])
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !teammateId || item.teammateId === teammateId),
    }))
    .filter((section) => section.items.length > 0);
  const none = (everyone.sections ?? []).every((section) => section.items.length === 0);

  if (none)
    return (
      <Empty
        icon={<CalendarClock size={28} color={colors.mutedForeground} />}
        title="No automations yet"
        body={NEW_NOTE}
      />
    );

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottom + space(6) }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      testID="automations"
    >
      <Stack.Screen options={{ title: "Automations" }} />
      <View style={styles.top}>
        <ConnectionNotice />
        {filters.length > 2 && (
          <FilterChips
            options={filters}
            value={teammateId ?? "all"}
            onChange={(key) => setTeammateId(key === "all" ? null : key)}
          />
        )}
      </View>
      {computerOffline && (
        <View
          style={[styles.offline, { backgroundColor: colors.subtle, borderColor: colors.border }]}
          testID="automations-offline"
        >
          <CloudOff size={16} color={colors.mutedForeground} />
          <Text variant="small" style={{ flex: 1 }}>
            <Text variant="small" style={{ fontWeight: "600" }}>
              The computer is offline.
            </Text>{" "}
            <Text variant="small" muted>
              Schedules and watches wait, and run when it's back.
            </Text>
          </Text>
        </View>
      )}
      {sections.length === 0 && (
        <Text variant="small" muted style={styles.inset}>
          Nothing here for this teammate.
        </Text>
      )}
      {sections.map((section) => (
        <Section
          key={section.key}
          title={section.heading}
          action={
            <View style={[styles.count, { backgroundColor: colors.subtle }]}>
              <Text variant="caption" muted style={styles.countText}>
                {section.items.length}
              </Text>
            </View>
          }
        >
          <View testID={`section-${section.key}`}>
            <Card>
              {section.items.map((automation, index) => (
                <AutomationRow
                  key={`${automation.type}-${automation.id}`}
                  automation={automation}
                  teammate={allTeammates.find((teammate) => teammate.id === automation.teammateId)}
                  computerOnline={!computerOffline}
                  first={index === 0}
                />
              ))}
            </Card>
          </View>
        </Section>
      ))}
      <Text variant="small" muted style={styles.inset}>
        {NEW_NOTE}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: 0, gap: space(6) },
  // The chips bring their own side padding; the list's is taken back so they line up.
  top: { marginHorizontal: -space(4), gap: space(1), marginBottom: -space(3) },
  inset: { paddingHorizontal: space(1) },
  count: {
    minWidth: 24,
    paddingHorizontal: space(2),
    borderRadius: radius.full,
    alignItems: "center",
  },
  countText: { fontWeight: "500", fontVariant: ["tabular-nums"], lineHeight: 20 },
  offline: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(3.5),
    paddingVertical: space(3),
  },
});
