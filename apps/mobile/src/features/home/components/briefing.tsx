import type { TeammateSummary, BriefingItem } from "@open-bot/api";
import { plural } from "@open-bot/chat-core";
import { plainText } from "@open-bot/domain";
import { router } from "expo-router";
import { AlertCircle, History, X } from "lucide-react-native";
import { Pressable, View, StyleSheet } from "react-native";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { Text } from "@/components/text";
import { chatHref } from "@/lib/links";
import { animateLayout } from "@/lib/motion";
import { usePresence } from "@/lib/presence";
import { phoneDayClock } from "@/lib/phone-clock";
import { space, useColors, radius } from "@/theme";
import { TRIGGER_ICONS } from "./trigger-icons";
import { shared } from "./styles";
import { briefingGroups } from "@/features/home/home";

/** The most replies shown for each teammate in the briefing. */
const PER_BOT = 3;

export function Briefing({
  items,
  teammates,
  since,
}: {
  items: BriefingItem[];
  teammates: TeammateSummary[];
  since: string;
}) {
  const colors = useColors();
  const { dismiss } = usePresence();
  if (items.length === 0) return null;
  const { groups, done, failed } = briefingGroups(items);
  return (
    <View
      style={[styles.briefing, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="briefing"
    >
      <View style={styles.briefingHead}>
        <View style={[shared.mark, { backgroundColor: colors.subtle }]}>
          <History size={18} color={colors.foreground} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">While you were away</Text>
          <Text variant="small" muted>
            {[done > 0 && `${plural(done, "task")} done`, failed > 0 && `${failed} failed`]
              .filter(Boolean)
              .join(", ")}{" "}
            since {phoneDayClock(since)}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            animateLayout();
            dismiss();
          }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss the briefing"
          android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
          style={styles.dismiss}
        >
          <X size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
      {groups.map(([botId, botItems]) => {
        const bot = teammates.find((entry) => entry.id === botId);
        const extra = botItems.length - PER_BOT;
        return (
          <View key={botId} style={styles.briefingBot}>
            <BotAvatar
              name={bot?.name ?? "?"}
              color={bot?.color ?? "#888888"}
              emoji={bot?.emoji}
              size="sm"
            />
            <View style={{ flex: 1 }}>
              <View style={styles.briefingName}>
                <Text variant="label" style={{ fontSize: 14 }}>
                  {bot?.name ?? "Former teammate"}
                </Text>
                <Text variant="small" muted>
                  · {plural(botItems.length, "task")}
                </Text>
              </View>
              {botItems.slice(0, PER_BOT).map((item) => {
                const Icon =
                  item.status === "failed"
                    ? AlertCircle
                    : item.trigger in TRIGGER_ICONS
                      ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
                      : null;
                return (
                  <Pressable
                    key={item.runId}
                    onPress={() => router.push(chatHref(item.chatId, item.runId))}
                    accessibilityRole="button"
                    style={styles.briefingItem}
                  >
                    <View style={{ width: 14, paddingTop: 3 }}>
                      {Icon && (
                        <Icon
                          size={13}
                          color={
                            item.status === "failed" ? colors.destructive : colors.mutedForeground
                          }
                        />
                      )}
                    </View>
                    <Text
                      variant="small"
                      numberOfLines={2}
                      style={[
                        { flex: 1, fontSize: 14, lineHeight: 19 },
                        item.status === "failed" && { color: colors.destructive },
                      ]}
                    >
                      {item.automationTitle && (
                        <Text variant="small" style={{ fontWeight: "600", fontSize: 14 }}>
                          {item.automationTitle}:{" "}
                        </Text>
                      )}
                      {plainText(item.preview ?? (item.status === "failed" ? "Failed" : "Done"))}
                    </Text>
                    <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                      {phoneDayClock(item.completedAt)}
                    </Text>
                  </Pressable>
                );
              })}
              {extra > 0 && (
                <Text variant="caption" muted style={{ paddingLeft: space(5.5), paddingTop: 2 }}>
                  and {extra} more
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  briefing: {
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingTop: space(4),
    paddingBottom: space(3),
    gap: space(4),
  },
  briefingHead: { flexDirection: "row", alignItems: "center", gap: space(3) },
  dismiss: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -space(2),
  },
  briefingBot: { flexDirection: "row", gap: space(3) },
  briefingName: { flexDirection: "row", alignItems: "center", gap: space(1.5), height: 28 },
  briefingItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(2),
    paddingVertical: space(1.5),
    minHeight: 32,
  },
});
