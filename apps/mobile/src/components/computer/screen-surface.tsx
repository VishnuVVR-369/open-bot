import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View, useColorScheme } from "react-native";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * The colors of a screen that isn't showing anything: a dark panel, like a monitor that's off.
 * In dark mode it sits below the card it's on, with a border so it doesn't melt into the page.
 */
export function useScreenSurface() {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  return dark
    ? { background: colors.background, ink: colors.mutedForeground, border: colors.border }
    : {
        background: colors.foreground,
        ink: mix(colors.primaryForeground, colors.foreground, 0.7),
        border: colors.foreground,
      };
}

/** A centred icon, line and caption on a screen surface, or a spinner while something starts. */
export function ScreenMessage({
  icon,
  title,
  body,
  spinner,
  action,
}: {
  icon?: ReactNode;
  title?: string;
  body?: string;
  spinner?: boolean;
  action?: ReactNode;
}) {
  const surface = useScreenSurface();
  return (
    <View style={styles.message}>
      {spinner ? <ActivityIndicator color={surface.ink} /> : icon}
      {title ? (
        <Text variant="label" style={[styles.center, { color: surface.ink }]}>
          {title}
        </Text>
      ) : null}
      {body ? (
        <Text variant="small" style={[styles.center, { color: surface.ink, opacity: 0.8 }]}>
          {body}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

/** A screen-shaped panel for when nothing live is shown, such as on the Computer list. */
export function ScreenPanel({
  children,
  aspectRatio,
  tint,
}: {
  children?: ReactNode;
  aspectRatio: number;
  /** A ring for a screen that needs you. */
  tint?: string;
}) {
  const surface = useScreenSurface();
  return (
    <View
      style={[
        styles.panel,
        {
          aspectRatio,
          backgroundColor: surface.background,
          borderColor: tint ?? surface.border,
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: space(2),
    padding: space(5),
  },
  center: { textAlign: "center", maxWidth: 280 },
  panel: {
    width: "100%",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: "hidden",
  },
});
