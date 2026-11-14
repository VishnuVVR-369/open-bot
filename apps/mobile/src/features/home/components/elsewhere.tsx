import type { ActivityItem, BotSummary } from "@open-bot/api";
import { isRunActive, plainText } from "@open-bot/domain";
import { router } from "expo-router";
import { Users } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import {
  activityColor,
  activityText,
  BotAvatar,
  type BotActivity,
} from "@/features/teammates/components/bot-avatar";
import { Text } from "@/components/text";
import { chatHref } from "@/lib/links";
import { ago } from "@/lib/time";
import { useColors, space } from "@/theme";
import { useMemo } from "react";
import { Card, Section } from "@/components/section";
import { activityPlace, elsewhere } from "@/features/home/home";
import { SeeAll } from "./see-all";
import { TRIGGER_ICONS } from "./trigger-icons";

function ActivityRow({
  item,
  bot,
  first,
  computerOffline,
}: {
  item: ActivityItem;
  bot?: BotSummary;
  first: boolean;
  computerOffline: boolean;
}) {
  const colors = useColors();
  const active = isRunActive(item.status);
  // A run that is still going reads like its teammate does: needs you, working, or paused.
  const activity: BotActivity =
    item.status === "waiting" ? "waiting" : computerOffline ? "paused" : "working";
  const Icon =
    item.chatKind === "group"
      ? Users
      : item.trigger in TRIGGER_ICONS
        ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
        : null;
  const where = activityPlace(item);
  return (
    <Pressable
      onPress={() => router.push(chatHref(item.chatId, item.runId))}
      accessibilityRole="button"
      android_ripple={{ color: colors.muted }}
      style={[
        styles.activity,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <BotAvatar
        name={bot?.name ?? "?"}
        color={bot?.color ?? "#888888"}
        emoji={bot?.emoji}
        size="sm"
      />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.activityMeta}>
          <Text variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
            {bot?.name ?? "Former teammate"}
          </Text>
          {Icon && <Icon size={12} color={colors.mutedForeground} />}
          {where && (
            <Text variant="small" muted numberOfLines={1} style={{ flexShrink: 1 }}>
              {where}
            </Text>
          )}
          <Text variant="caption" muted style={{ marginLeft: "auto" }}>
            {ago(item.createdAt)}
          </Text>
        </View>
        {active ? (
          <Text variant="small" style={{ fontSize: 14, color: activityColor(activity, colors) }}>
            {activityText(
              activity,
              bot?.activeRun?.id === item.runId ? bot.activeRun.waitingFor : null,
            )}
          </Text>
        ) : (
          <Text
            variant="small"
            numberOfLines={2}
            style={[
              { fontSize: 14, lineHeight: 19 },
              item.status === "failed" && { color: colors.destructive },
            ]}
          >
            {plainText(item.preview ?? (item.status === "interrupted" ? "Stopped" : "Done"))}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** Recent turns in groups and automations, with a way to every chat. */
export function Elsewhere({
  activity,
  teammates,
  computerOffline,
}: {
  activity: ActivityItem[];
  teammates: BotSummary[];
  computerOffline: boolean;
}) {
  const recent = useMemo(() => elsewhere(activity), [activity]);
  if (recent.length === 0) return null;
  return (
    <Section
      title="Elsewhere"
      action={<SeeAll label="All chats" onPress={() => router.navigate("/chats")} />}
    >
      <Card>
        {recent.map((item, index) => (
          <ActivityRow
            key={item.runId}
            item={item}
            bot={teammates.find((teammate) => teammate.id === item.botId)}
            first={index === 0}
            computerOffline={computerOffline}
          />
        ))}
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  activity: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  activityMeta: { flexDirection: "row", alignItems: "center", gap: space(1.5), minHeight: 28 },
});
