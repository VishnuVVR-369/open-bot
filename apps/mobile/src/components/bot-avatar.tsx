import type { BotSummary } from "@open-bot/api";
import { StyleSheet, Text, View } from "react-native";
import { fonts, useColors } from "@/theme";
import { mix } from "@/theme/mix";

export type BotActivity = "idle" | "working" | "waiting" | "queued";

const SIZES = {
  sm: { box: 28, radius: 8, font: 12 },
  md: { box: 36, radius: 10, font: 14 },
  lg: { box: 48, radius: 13, font: 18 },
} as const;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 1).toUpperCase();
}

export function botActivity(bot: Pick<BotSummary, "activeRun">): BotActivity {
  const run = bot.activeRun;
  if (!run) return "idle";
  if (run.status === "waiting") return "waiting";
  if (run.status === "queued") return "queued";
  return "working";
}

export function botStatusText(bot: Pick<BotSummary, "activeRun" | "role">): string {
  const run = bot.activeRun;
  if (!run) return bot.role;
  if (run.status === "waiting")
    return run.waitingFor === "takeover" ? "Needs you to take over" : "Needs your approval";
  if (run.status === "queued") return "Up next";
  return "Working…";
}

/** A teammate's tile, as on the web: their color, their emoji or initials, and a status light. */
export function BotAvatar({
  name,
  color,
  emoji,
  size = "md",
  activity = "idle",
}: {
  name: string;
  color: string;
  emoji?: string;
  size?: keyof typeof SIZES;
  activity?: BotActivity;
}) {
  const colors = useColors();
  const dims = SIZES[size];
  return (
    <View>
      <View
        style={{
          width: dims.box,
          height: dims.box,
          borderRadius: dims.radius,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: mix(color, colors.surface, 0.16),
          borderWidth: 1,
          borderColor: mix(color, colors.surface, 0.3),
        }}
      >
        <Text
          style={{
            fontFamily: fonts.heading,
            fontWeight: "600",
            fontSize: dims.font,
            color: mix(color, colors.foreground, 0.78),
          }}
        >
          {emoji || initials(name)}
        </Text>
      </View>
      {activity !== "idle" && (
        <View
          style={[
            styles.light,
            {
              borderColor: colors.background,
              backgroundColor:
                activity === "working"
                  ? colors.live
                  : activity === "waiting"
                    ? colors.waiting
                    : colors.mutedForeground,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  light: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
  },
});
