import type { ScreenView } from "@open-bot/api";
import { CloudOff, Hand, Monitor, Moon, MousePointer2 } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { BotAvatar, botActivity } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { screenState, screenStatus, type ScreenState } from "@/lib/screens";
import { radius, space, useColors } from "@/theme";
import { DESKTOP_ASPECT_RATIO } from "./desktop-view";
import { ScreenPanel, useScreenSurface } from "./screen-surface";

/** The one thing to do from the list, if any: an offline computer has nothing to offer. */
export type ScreenAction = "wake" | "watch" | "take-over" | "open";

export function screenAction(state: ScreenState): ScreenAction | null {
  switch (state.kind) {
    case "needs-you":
      return "take-over";
    case "asleep":
      return "wake";
    case "controlling":
      return "open";
    case "offline":
      return null;
    default:
      return "watch";
  }
}

const ACTION_TITLE: Record<ScreenAction, string> = {
  wake: "Wake",
  watch: "Watch",
  "take-over": "Take over",
  open: "Open",
};

/**
 * A teammate's screen on the Computer list: who, what it's doing, and a quiet stand-in for the
 * screen itself. It never opens a live stream; that only happens once you open the screen.
 */
export function ScreenCard({
  screen,
  busy,
  onOpen,
  onAction,
}: {
  screen: ScreenView;
  /** The action under way on this screen, if any. */
  busy: ScreenAction | null;
  onOpen: () => void;
  onAction: (action: ScreenAction) => void;
}) {
  const colors = useColors();
  const state = screenState(screen);
  const action = screenAction(state);
  const needsYou = state.kind === "needs-you";
  const status =
    busy === "wake" ? "Waking up…" : busy === "take-over" ? "Taking over…" : screenStatus(screen);
  const detail = needsYou && state.reason ? `${status}: ${state.reason}` : status;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${screen.bot.name}'s screen. ${detail}`}
      accessibilityHint="Opens the screen"
      testID={`screen-${screen.id}`}
      android_ripple={{ color: colors.muted, borderless: false }}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: needsYou ? colors.attention : colors.border,
          opacity: pressed ? 0.92 : 1,
        },
      ]}
    >
      <ScreenPanel
        aspectRatio={DESKTOP_ASPECT_RATIO}
        tint={needsYou ? colors.attention : undefined}
      >
        <PanelGlyph state={state} />
      </ScreenPanel>
      <View style={styles.footer}>
        <BotAvatar
          name={screen.bot.name}
          color={screen.bot.color}
          emoji={screen.bot.emoji}
          activity={needsYou ? "waiting" : botActivity(screen.bot)}
        />
        <View style={styles.text}>
          <Text variant="label" numberOfLines={1}>
            {screen.bot.name}
          </Text>
          <Text
            variant="small"
            muted={!needsYou}
            numberOfLines={2}
            style={needsYou ? { color: colors.attentionInk } : undefined}
          >
            {detail}
          </Text>
        </View>
        {action && (
          <Button
            title={ACTION_TITLE[action]}
            variant={action === "wake" || action === "take-over" ? "primary" : "outline"}
            onPress={() => onAction(action)}
            busy={busy !== null}
            testID={`screen-${screen.id}-${action}`}
          />
        )}
      </View>
    </Pressable>
  );
}

/** One calm mark per state, centred on the dark panel. */
function PanelGlyph({ state }: { state: ScreenState }) {
  const colors = useColors();
  const surface = useScreenSurface();
  const size = 26;
  const icon =
    state.kind === "asleep" ? (
      <Moon size={size} color={surface.ink} />
    ) : state.kind === "offline" ? (
      <CloudOff size={size} color={surface.ink} />
    ) : state.kind === "needs-you" ? (
      <Hand size={size} color={colors.attention} />
    ) : state.kind === "controlling" ? (
      <MousePointer2 size={size} color={surface.ink} />
    ) : (
      <Monitor size={size} color={surface.ink} />
    );
  return (
    <View style={styles.glyph} accessible={false}>
      {icon}
      {state.kind === "using" && (
        // A teammate at work: the same calm blue their avatar pulses with.
        <View style={[styles.workingDot, { backgroundColor: colors.working }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space(3),
    gap: space(3),
    overflow: "hidden",
  },
  footer: { flexDirection: "row", alignItems: "center", gap: space(3), paddingLeft: space(1) },
  text: { flex: 1, gap: space(0.5) },
  glyph: { flex: 1, alignItems: "center", justifyContent: "center" },
  workingDot: {
    position: "absolute",
    width: space(2),
    height: space(2),
    borderRadius: radius.full,
    top: space(3),
    right: space(3),
  },
});
