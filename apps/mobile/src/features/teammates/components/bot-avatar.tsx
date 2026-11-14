import type { TeammateSummary } from "@open-bot/api";
import { STATUS, teammateStatus, type TeammateActivity } from "@open-bot/domain";
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { useReducedMotion } from "@/lib/motion";
import { fonts, useColors, type Colors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * What a teammate is up to, which their avatar shows. `waiting` means waiting for you; `paused`
 * means waiting for the offline computer. The same as the shared `TeammateActivity`.
 */
export type BotActivity = TeammateActivity;

const SIZES = {
  xs: { box: 24, radius: 7, font: 13 },
  sm: { box: 28, radius: 8, font: 15 },
  // Headers and compact rows.
  md: { box: 36, radius: 11, font: 18 },
  // List rows.
  lg: { box: 44, radius: 13, font: 22 },
  // Each of a group's two faces in a list row.
  group: { box: 31, radius: 9, font: 17 },
  // A profile's header, beside the name.
  profile: { box: 72, radius: 21, font: 36 },
} as const;

export type AvatarSize = keyof typeof SIZES;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 1).toUpperCase();
}

/**
 * The words for a teammate's status, the same on every surface (Home, the Computer tab, chat
 * headers) and the same as the web's: one list, in packages/domain. The line under a teammate's
 * name says only this, never their job.
 */
export { STATUS };

/** "Paused" with its reason, for a place that doesn't already say the computer is offline. */
export const PAUSED_OFFLINE = `${STATUS.paused}, computer offline`;

/**
 * What a teammate is doing, by the shared rule (packages/domain `teammateStatus`): waiting on you
 * still needs you, offline or not; everyone else is paused while the computer (from
 * `useComputerOffline`) is offline.
 */
export function botActivity(
  bot: Pick<TeammateSummary, "activeRun">,
  computerOffline = false,
): BotActivity {
  return teammateStatus(bot, !computerOffline).activity;
}

/** The words for what a teammate is up to, from the fixed list in `STATUS`. */
export function activityText(activity: BotActivity, waitingFor?: string | null): string {
  switch (activity) {
    case "waiting":
      return needsYouText(waitingFor);
    case "working":
      return STATUS.working;
    case "paused":
      return STATUS.paused;
    case "queued":
      return STATUS.upNext;
    case "idle":
      return STATUS.idle;
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
  return waitingFor === "takeover" ? STATUS.takeover : STATUS.approval;
}

/**
 * A teammate's status as a line: a small light and the words. The light is amber when they need
 * you, blue while working, gray while paused or up next, and an empty ring while they're free.
 * `children` replaces the words (the chat header adds who and why).
 */
export function StatusLine({
  activity,
  waitingFor,
  size = "small",
  children,
  testID,
}: {
  activity: BotActivity;
  waitingFor?: string | null;
  size?: "small" | "caption";
  children?: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  const color = activityColor(activity, colors);
  const light =
    activity === "waiting"
      ? colors.attention
      : activity === "working"
        ? colors.working
        : colors.mutedForeground;
  const dot = size === "caption" ? 6 : 7;
  const caption = size === "caption";
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: caption ? 5 : 6, flexShrink: 1 }}
    >
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          ...(activity === "idle"
            ? { borderWidth: 1.5, borderColor: light }
            : { backgroundColor: light }),
        }}
      />
      <Text
        numberOfLines={1}
        testID={testID}
        style={{
          flexShrink: 1,
          fontFamily: fonts.sans,
          fontSize: caption ? 12.5 : 14,
          lineHeight: caption ? 16 : 19,
          fontWeight: activity === "waiting" ? "500" : "400",
          color,
        }}
      >
        {children ?? activityText(activity, waitingFor)}
      </Text>
    </View>
  );
}

/** The lead teammate's mark beside their name, the web's small "Lead" badge. */
export function LeadBadge() {
  const colors = useColors();
  return (
    <View
      style={{
        backgroundColor: colors.subtle,
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 1,
      }}
      accessibilityLabel="Lead"
    >
      <Text
        allowFontScaling={false}
        style={{
          fontFamily: fonts.sans,
          fontSize: 11,
          lineHeight: 15,
          fontWeight: "500",
          color: colors.mutedForeground,
        }}
      >
        Lead
      </Text>
    </View>
  );
}

const ACTIVITY_LABEL: Record<BotActivity, string> = {
  idle: "",
  working: "working",
  paused: "paused",
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

/**
 * Two teammates' faces for a group chat, offset diagonally so both stay readable: the front one
 * sits in a ring of whatever is behind it, and covers only a corner of the one at the back.
 */
export function GroupAvatar({
  members,
  size = "lg",
  ring,
}: {
  members: Pick<TeammateSummary, "name" | "color" | "emoji">[];
  size?: "md" | "lg";
  /** What's behind the avatar, so the front face's cut-out ring matches it. */
  ring?: string;
}) {
  const colors = useColors();
  const box = GROUP[size].box;
  const shown = members.slice(0, 2);
  if (shown.length < 2)
    return shown[0] ? (
      <BotAvatar {...shown[0]} size={size} />
    ) : (
      <View style={{ width: box, height: box }} />
    );
  const inner = GROUP[size].tile;
  const tile = SIZES[inner];
  const edge = 2;
  return (
    <View style={{ width: box, height: box }}>
      <View style={{ position: "absolute", top: 0, left: 0 }}>
        <BotAvatar {...shown[0]!} size={inner} />
      </View>
      <View
        style={{
          position: "absolute",
          right: -edge,
          bottom: -edge,
          borderRadius: tile.radius + edge,
          borderWidth: edge,
          borderColor: ring ?? colors.background,
          width: tile.box + edge * 2,
          height: tile.box + edge * 2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <BotAvatar {...shown[1]!} size={inner} />
      </View>
    </View>
  );
}

/**
 * A group's faces in a row for its chat header: up to three, overlapping a little, each cut out
 * of what's behind it, and "+2" for the rest.
 */
export function AvatarStack({
  members,
  max = 3,
  ring,
}: {
  members: Pick<TeammateSummary, "id" | "name" | "color" | "emoji">[];
  max?: number;
  /** What's behind the stack, so each face's cut-out ring matches it. */
  ring?: string;
}) {
  const colors = useColors();
  const tile = SIZES.sm;
  const edge = 2;
  const overlap = 10;
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  const outer = tile.box + edge * 2;
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center" }}
      accessible
      accessibilityLabel={members.map((member) => member.name).join(", ")}
    >
      {shown.map((member, index) => (
        <View
          key={member.id}
          style={{
            marginLeft: index === 0 ? -edge : -overlap,
            width: outer,
            height: outer,
            borderRadius: tile.radius + edge,
            borderWidth: edge,
            borderColor: ring ?? colors.background,
            alignItems: "center",
            justifyContent: "center",
            zIndex: max - index,
          }}
        >
          <BotAvatar {...member} size="sm" />
        </View>
      ))}
      {rest > 0 && (
        <View
          style={{
            marginLeft: -overlap,
            height: outer,
            minWidth: outer,
            paddingHorizontal: 5,
            borderRadius: tile.radius + edge,
            borderWidth: edge,
            borderColor: ring ?? colors.background,
            backgroundColor: colors.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            allowFontScaling={false}
            style={{
              fontFamily: fonts.sans,
              fontSize: 12,
              lineHeight: 16,
              fontWeight: "600",
              color: colors.mutedForeground,
            }}
          >
            +{rest}
          </Text>
        </View>
      )}
    </View>
  );
}

/** A group's two tiles and the box they share: about 70% of the box each. */
const GROUP = {
  md: { box: 42, tile: "sm" },
  lg: { box: 46, tile: "group" },
} as const;
