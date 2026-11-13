import type { ScreenView } from "@open-bot/api";
import { Hand, ShieldAlert } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { BotAvatar, botActivity } from "@/features/teammates/components/bot-avatar";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { screenState, screenStatus } from "@/features/computer/screens";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** Whose screen this is and what it's doing, for the header (or the side column in landscape). */
export function ScreenTitle({ screen }: { screen: ScreenView }) {
  const colors = useColors();
  const needsYou = screenState(screen).kind === "needs-you";
  return (
    <View style={styles.title}>
      <BotAvatar
        name={screen.bot.name}
        color={screen.bot.color}
        emoji={screen.bot.emoji}
        size="sm"
        activity={needsYou ? "waiting" : botActivity(screen.bot)}
      />
      <View style={{ flexShrink: 1 }}>
        <Text variant="heading" numberOfLines={1}>
          {`${screen.bot.name}'s screen`}
        </Text>
        <Text
          variant="caption"
          muted={!needsYou}
          numberOfLines={1}
          style={needsYou ? { color: colors.attentionInk } : undefined}
          testID="screen-status"
        >
          {screenStatus(screen)}
        </Text>
      </View>
    </View>
  );
}

/** A teammate asked you to step in: why, and the shortcut for a one-time code. */
export function TakeoverNotice({
  name,
  reason,
  onTypeCode,
}: {
  name: string;
  reason: string | null;
  onTypeCode: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.notice,
        {
          borderColor: colors.attention,
          backgroundColor: mix(colors.attention, colors.surface, 0.12),
        },
      ]}
    >
      <View style={styles.noticeRow}>
        <Hand size={18} color={colors.attentionInk} style={styles.noticeIcon} />
        <View style={styles.noticeText}>
          <Text variant="label" style={{ color: colors.attentionInk }}>
            {`${name} needs you to take over`}
          </Text>
          <Text variant="small">{reason ?? "Take over to help, then hand the screen back."}</Text>
        </View>
      </View>
      <Button title="Type the code" variant="outline" onPress={onTypeCode} testID="type-code" />
    </View>
  );
}

/** You're driving: say so plainly, so it's clear your taps reach a real computer. */
export function ControlNotice({ name, paused }: { name: string; paused: boolean }) {
  const colors = useColors();
  return (
    <View
      style={[styles.notice, { borderColor: colors.border, backgroundColor: colors.surface }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.noticeRow}>
        {paused ? (
          <ShieldAlert size={18} color={colors.attentionInk} style={styles.noticeIcon} />
        ) : (
          <View style={[styles.liveDot, { backgroundColor: colors.live }]} />
        )}
        <View style={styles.noticeText}>
          <Text variant="label">{`You're controlling ${name}'s screen`}</Text>
          <Text variant="small" muted>
            {paused
              ? "Paused for safety. A code may still be on screen, so clear it before you hand back."
              : `${name} waits until you hand back.`}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { flexDirection: "row", alignItems: "center", gap: space(2.5), maxWidth: 260 },
  notice: {
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space(3),
    gap: space(3),
  },
  noticeRow: { flexDirection: "row", alignItems: "flex-start", gap: space(2.5) },
  noticeIcon: { marginTop: 1 },
  noticeText: { flex: 1, gap: space(0.5) },
  // Centred on the first line of the title beside it.
  liveDot: {
    width: space(2.5),
    height: space(2.5),
    borderRadius: radius.full,
    marginTop: space(1.25),
    marginHorizontal: space(1),
  },
});
