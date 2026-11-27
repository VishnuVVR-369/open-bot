import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  CalendarClock,
  CloudOff,
  ExternalLink,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Card } from "@/components/section";
import { LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { Toggle } from "@/components/toggle";
import { useComputerOffline } from "@/features/computer/hooks";
import { HeaderButton } from "@/features/home/components/header-actions";
import { useTeammates } from "@/features/teammates/hooks";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { openOutside } from "@/lib/open-outside";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { OFFLINE_ACTION, viewerTimeZone } from "@open-bot/domain";
import { radius, space, useColors } from "@/theme";
import {
  checkTriggerNow,
  confirmDeleteAutomation,
  newRunKeys,
  runScheduleNow,
  setAutomationEnabled,
  type ActionOutcome,
} from "../actions";
import {
  AUTOMATIONS_HREF,
  automationEditHref,
  canTurnOn,
  emptyHistory,
  isAutomationType,
  kindName,
  lastLine,
  mainAction,
  stateBadge,
  webOnlyNote,
  keepTimesWhole,
  whenLine,
  zoneNote,
  type Automation,
} from "../automations";
import { useAutomation, useAutomationRuns } from "../hooks";
import { AutomationAvatar, StateBadge } from "./automation-parts";
import { RunHistory } from "./run-history";

const phoneZone = viewerTimeZone;

/**
 * One automation: who runs it and when, its switch, "Run now" or "Check now", what it does,
 * and its recent runs, each opening its chat. Renaming and timing are a tap on Edit; the rest of
 * its setup is the web's, which a note says.
 */
export default function AutomationScreen() {
  const params = useLocalSearchParams<{ kind: string; automationId: string }>();
  const type = isAutomationType(params.kind) ? params.kind : "schedule";
  const { automation, gone, isLoading, error, refetch } = useAutomation(type, params.automationId);
  if (isAutomationType(params.kind) && automation && !gone)
    return <AutomationDetails automation={automation} />;
  return (
    <>
      {/* No Edit without an automation, also once it's deleted while open. */}
      <Stack.Screen options={{ headerRight: () => null }} />
      {!isAutomationType(params.kind) || gone ? (
        <NotFound
          icon={CalendarClock}
          title="This automation is gone"
          body="It was deleted, or the link is wrong. Past runs stay in their chats."
          action="See automations"
          onAction={() => router.replace(AUTOMATIONS_HREF)}
        />
      ) : isLoading ? (
        <Loading />
      ) : (
        <LoadError error={error} onRetry={() => void refetch()} title="Couldn't load it" />
      )}
    </>
  );
}

function AutomationDetails({ automation }: { automation: Automation }) {
  const colors = useColors();
  const bottom = useSafeBottom();
  const online = useOnline();
  const computerOffline = useComputerOffline();
  const { data: teammates = [] } = useTeammates();
  const runs = useAutomationRuns(automation.type, automation.id);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  // "Run now" ids kept for a retry on this screen only: once you leave, a tap is a new ask.
  const [runKeys] = useState(newRunKeys);
  useEffect(() => () => runKeys.clear(), [runKeys]);
  const { refreshing, onRefresh } = usePullToRefresh(() => runs.refetch());
  const teammate = teammates.find((entry) => entry.id === automation.teammateId);
  const teammateName = teammate?.name ?? "Your teammate";
  const action = mainAction(automation);
  const badge = stateBadge(automation);
  const last = lastLine(automation);
  const unavailable = !online ? "You're offline." : computerOffline ? OFFLINE_ACTION : null;

  async function act() {
    if (!action) return;
    haptics.press();
    setBusy(true);
    setOutcome(null);
    const result =
      automation.type === "schedule"
        ? await runScheduleNow(automation, teammateName, runKeys)
        : await checkTriggerNow(automation, teammateName);
    setBusy(false);
    setOutcome(result);
  }

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
      testID="automation"
    >
      <Stack.Screen
        options={{
          title: "",
          headerRight: () => (
            <HeaderButton
              label="Edit"
              onPress={() => {
                haptics.tap();
                router.push(automationEditHref(automation));
              }}
              testID="automation-edit"
            >
              <Pencil size={21} color={colors.foreground} />
            </HeaderButton>
          ),
        }}
      />
      <View style={styles.hero}>
        <AutomationAvatar automation={automation} teammate={teammate} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.titleRow}>
            <Text variant="title" style={{ flexShrink: 1 }} testID="automation-title">
              {automation.title}
            </Text>
            {badge && <StateBadge label={badge} />}
          </View>
          <Text variant="small" muted>
            {`${capitalize(kindName(automation))} · ${teammate?.name ?? "A former teammate"}`}
            {automation.createdBy === "teammate" ? ` · set up by ${teammateName}` : ""}
          </Text>
        </View>
      </View>

      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">
              {keepTimesWhole(whenLine(automation, { computerOnline: !computerOffline }))}
            </Text>
            {last && (
              <Text
                variant="small"
                style={{ color: last.failed ? colors.destructive : colors.mutedForeground }}
              >
                {last.text}
              </Text>
            )}
            {automation.type === "schedule" && (
              <Text variant="caption" muted>
                {zoneNote(automation.timezone, phoneZone())}
              </Text>
            )}
          </View>
          {canTurnOn(automation) && (
            <Toggle
              value={automation.enabled}
              onValueChange={(enabled) => void setAutomationEnabled(automation, enabled)}
              disabled={!online}
              accessibilityLabel="On"
              testID="automation-enabled"
            />
          )}
        </View>
      </Card>

      {action && (
        <View style={{ gap: space(2) }}>
          <Button
            title={action.label}
            variant="outline"
            icon={
              action.kind === "run" ? (
                <Play size={16} color={colors.foreground} fill={colors.foreground} />
              ) : (
                <RefreshCw size={16} color={colors.foreground} />
              )
            }
            onPress={() => void act()}
            disabled={Boolean(unavailable)}
            busy={busy}
            testID="automation-action"
          />
          {unavailable && !busy ? (
            <View style={styles.note}>
              <CloudOff size={14} color={colors.mutedForeground} />
              <Text variant="caption" muted style={{ flex: 1 }}>
                {unavailable}
              </Text>
            </View>
          ) : outcome ? (
            <View
              style={[styles.outcome, { backgroundColor: colors.subtle }]}
              testID="automation-outcome"
            >
              <Text
                variant="small"
                style={{
                  fontWeight: "600",
                  color: outcome.failed ? colors.destructive : colors.foreground,
                }}
              >
                {outcome.title}
              </Text>
              {outcome.body && (
                <Text variant="small" muted>
                  {outcome.body}
                </Text>
              )}
            </View>
          ) : null}
        </View>
      )}

      <Details automation={automation} />

      <RunHistory
        runs={runs.data}
        loading={runs.isLoading}
        empty={emptyHistory(automation)}
        yours={outcome?.runId ?? null}
      />

      <Text variant="small" muted style={styles.inset} testID="automation-web-note">
        {webOnlyNote(automation)}
      </Text>

      <Button
        title="Delete"
        variant="destructive"
        icon={<Trash2 size={18} color={colors.destructive} />}
        disabled={!online}
        onPress={() =>
          confirmDeleteAutomation(automation, () => {
            if (router.canGoBack()) router.back();
            else router.replace(AUTOMATIONS_HREF);
          })
        }
        testID="automation-delete"
      />
    </ScrollView>
  );
}

/** What it does, and what it watches, read-only: the web edits these. */
function Details({ automation }: { automation: Automation }) {
  const colors = useColors();
  const rows: { label: string; value: ReactNode }[] = [];
  if (automation.type === "trigger" && automation.kind === "watch" && automation.url)
    rows.push({
      label: "Page",
      value: (
        <Pressable
          onPress={() => void openOutside(automation.url!)}
          accessibilityRole="link"
          style={styles.link}
          testID="automation-page"
        >
          <Text variant="small" numberOfLines={2} style={{ flexShrink: 1 }}>
            {automation.url}
          </Text>
          <ExternalLink size={14} color={colors.mutedForeground} />
        </Pressable>
      ),
    });
  if (automation.type === "trigger" && automation.kind === "watch")
    rows.push({
      label: "Wakes for",
      value: (
        <Text variant="small">
          {automation.lookFor ? `“${automation.lookFor}” appearing` : "Any change to the text"}
        </Text>
      ),
    });
  if (
    automation.type === "trigger" &&
    (automation.kind === "gmail" || automation.kind === "calendar")
  )
    rows.push({
      label: automation.kind === "gmail" ? "Mail" : "Events",
      value: <Text variant="small">{automation.account ?? "An account that was removed"}</Text>,
    });
  rows.push({
    label: "What to do",
    value: (
      <Text variant="small" testID="automation-prompt">
        {automation.prompt}
      </Text>
    ),
  });
  return (
    <Card>
      {rows.map((row, index) => (
        <View
          key={row.label}
          style={[
            styles.detail,
            index > 0 && {
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
            },
          ]}
        >
          <Text variant="overline" muted>
            {row.label}
          </Text>
          {row.value}
        </View>
      ))}
    </Card>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(1), gap: space(5) },
  hero: { flexDirection: "row", alignItems: "center", gap: space(4) },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space(2), flexWrap: "wrap" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    padding: space(4),
  },
  note: { flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(1) },
  outcome: {
    borderRadius: radius.lg,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    gap: 2,
  },
  inset: { paddingHorizontal: space(1) },
  detail: { padding: space(4), gap: space(1.5) },
  link: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
});
