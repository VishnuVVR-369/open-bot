import type { BotSummary } from "@open-bot/api";
import { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { useReducedMotion } from "@/lib/motion";
import { fonts, useColors, type Colors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * What a teammate is up to, which their avatar shows. `waiting` means waiting for you; `paused`
 * means they were working but the computer that runs their work is offline.
 */
export type BotActivity = "idle" | "working" | "paused" | "waiting" | "queued";

const SIZES = {
  xs: { box: 24, radius: 7, font: 13 },
  sm: { box: 28, radius: 8, font: 15 },
  // Headers and compact rows.
  md: { box: 36, radius: 11, font: 18 },
  // List rows.
  lg: { box: 44, radius: 13, font: 22 },
  // A profile's hero.
  xl: { box: 88, radius: 26, font: 44 },
} as const;

export type AvatarSize = keyof typeof SIZES;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 1).toUpperCase();
}

/** `computerOffline` (from `useComputerOffline`) turns work in progress into `paused`. */
export function botActivity(
  bot: Pick<BotSummary, "activeRun">,
  computerOffline = false,
): BotActivity {
  const run = bot.activeRun;
  if (!run) return "idle";
  if (run.status === "waiting") return "waiting";
  if (run.status === "queued") return "queued";
  return computerOffline ? "paused" : "working";
}

/** The words for what a teammate is up to, the same everywhere; null when they're free. */
export function activityText(activity: BotActivity, waitingFor?: string | null): string | null {
  switch (activity) {
    case "waiting":
      return needsYouText(waitingFor);
    case "working":
      return "Working on it…";
    case "paused":
      return "Paused, computer offline";
    case "queued":
      return "Up next";
    case "idle":
      return null;
  }
}

/** The color those words are in: amber when it needs you, blue while working, quiet otherwise. */
export function activityColor(activity: BotActivity, colors: Colors): string {
  if (activity === "waiting") return colors.attentionInk;
  if (activity === "working") return colors.working;
  return colors.mutedForeground;
}

/** The one phrase for each thing a teammate can be waiting on you for, everywhere in the app. */
export function needsYouText(waitingFor: string | null | undefined): string {
  return waitingFor === "takeover" ? "Needs you to take over" : "Needs your approval";
}

export function botStatusText(
  bot: Pick<BotSummary, "activeRun" | "role">,
  computerOffline = false,
): string {
  return activityText(botActivity(bot, computerOffline), bot.activeRun?.waitingFor) ?? bot.role;
}

const ACTIVITY_LABEL: Record<BotActivity, string> = {
  idle: "",
  working: "working",
  paused: "paused, computer offline",
  waiting: "needs you",
  queued: "up next",
};

/**
 * A teammate's face: their color and emoji (or initials). Presence is part of the face, not a
 * separate light: a ring that breathes while they work and a dashed ring while they're up next. Waiting
 * for you is said in words beside the face (amber text), not on it.
 */
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
  size?: AvatarSize;
  activity?: BotActivity;
}) {
  const colors = useColors();
  const dims = SIZES[size];
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  // A 2px ring hugging the tile with a hairline of air, following its shape and centered on it.
  const gap = 1.5;
  const width = 2;
  const ring = {
    position: "absolute" as const,
    top: -gap - width,
    left: -gap - width,
    right: -gap - width,
    bottom: -gap - width,
    borderRadius: dims.radius + gap + width,
    borderWidth: width,
  };

  useEffect(() => {
    if (activity !== "working" || reduced) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    // Starts and ends at full strength, so each loop restarts seamlessly.
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1800,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [activity, reduced, pulse]);

  const label = ACTIVITY_LABEL[activity];
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label ? `${name}, ${label}` : name}
      style={{ width: dims.box, height: dims.box }}
    >
      {activity === "working" && (
        <Animated.View
          pointerEvents="none"
          style={[
            ring,
            {
              borderColor: colors.working,
              // It breathes in place: only its strength changes, never its size or position.
              opacity: reduced
                ? 1
                : pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.35, 1] }),
            },
          ]}
        />
      )}
      {activity === "queued" && (
        <View
          pointerEvents="none"
          style={[ring, { borderColor: colors.mutedForeground, borderStyle: "dashed" }]}
        />
      )}
      <View
        style={{
          width: dims.box,
          height: dims.box,
          borderRadius: dims.radius,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: mix(color, colors.surface, 0.2),
          borderWidth: 1,
          borderColor: mix(color, colors.surface, 0.42),
        }}
      >
        <Text
          allowFontScaling={false}
          style={{
            fontFamily: fonts.heading,
            fontWeight: "600",
            fontSize: emoji ? dims.font : Math.round(dims.font * 0.72),
            lineHeight: Math.round(dims.box * 0.9),
            color: mix(color, colors.foreground, 0.7),
          }}
        >
          {emoji || initials(name)}
        </Text>
      </View>
    </View>
  );
}

/** Up to three teammates' faces, overlapping, for a group chat. */
export function GroupAvatar({
  members,
  size = "lg",
  ring,
}: {
  members: Pick<BotSummary, "name" | "color" | "emoji">[];
  size?: "md" | "lg";
  /** What's behind the avatar, so the front face's cut-out ring matches it. */
  ring?: string;
}) {
  const colors = useColors();
  const box = SIZES[size].box;
  const shown = members.slice(0, 2);
  if (shown.length < 2)
    return shown[0] ? (
      <BotAvatar {...shown[0]} size={size} />
    ) : (
      <View style={{ width: box, height: box }} />
    );
  const inner = size === "lg" ? "sm" : "xs";
  const innerBox = SIZES[inner].box;
  return (
    <View style={{ width: box, height: box }}>
      <View style={{ position: "absolute", top: 0, left: 0 }}>
        <BotAvatar {...shown[0]!} size={inner} />
      </View>
      <View
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          borderRadius: SIZES[inner].radius + 2,
          borderWidth: 2,
          borderColor: ring ?? colors.background,
          width: innerBox + 4,
          height: innerBox + 4,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <BotAvatar {...shown[1]!} size={inner} />
      </View>
    </View>
  );
}
