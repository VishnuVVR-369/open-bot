import type { EgressPath } from "@open-bot/api";
import { Cloud, CirclePause, Hourglass, Laptop, Smartphone } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import type { PhoneTone } from "@/features/settings/phone-connection";
import { radius, space, useColors, type Colors } from "@/theme";
import { mix } from "@/theme/mix";

/** The icon for where the computer's browser traffic goes. */
export function PathIcon({ path, size, color }: { path: EgressPath; size: number; color: string }) {
  const Icon = {
    desktop: Laptop,
    phone: Smartphone,
    direct: Cloud,
    waiting: Hourglass,
    blocked: CirclePause,
  }[path];
  return <Icon size={size} color={color} />;
}

/** The color a path or this phone's state is drawn in: green only while traffic is ours. */
export function toneColor(tone: PhoneTone, colors: Colors): string {
  return {
    active: colors.done,
    idle: colors.working,
    attention: colors.attention,
    off: colors.mutedForeground,
  }[tone];
}

export function pathTone(path: EgressPath): PhoneTone {
  return path === "desktop" || path === "phone"
    ? "active"
    : path === "waiting"
      ? "idle"
      : path === "blocked"
        ? "attention"
        : "off";
}

/**
 * Something to fix, in amber: what's wrong, why it matters and the one button that fixes it.
 */
export function Notice({
  icon,
  title,
  body,
  action,
  onAction,
  busy,
  testID,
}: {
  icon: (color: string) => ReactNode;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
  busy?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: mix(colors.attention, colors.surface, 0.1),
          borderColor: mix(colors.attention, colors.surface, 0.35),
        },
      ]}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <View style={styles.noticeHead}>
        {icon(colors.attentionInk)}
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label">{title}</Text>
          <Text variant="small" muted>
            {body}
          </Text>
        </View>
      </View>
      {action && onAction ? (
        <Button
          title={action}
          variant="outline"
          onPress={onAction}
          busy={busy}
          testID={testID ? `${testID}-action` : undefined}
        />
      ) : null}
    </View>
  );
}

/** One of a few choices, as a row with a radio mark, its name and a line about it. */
export function ChoiceRow({
  title,
  description,
  checked,
  disabled,
  onPress,
  testID,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: colors.muted }}
      style={styles.choice}
      accessibilityRole="radio"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={title}
      testID={testID}
    >
      <View
        style={[
          styles.radio,
          { borderColor: checked ? colors.foreground : colors.input },
          checked && { backgroundColor: colors.foreground },
        ]}
      >
        {checked && <View style={[styles.radioDot, { backgroundColor: colors.surface }]} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" style={disabled ? { color: colors.mutedForeground } : undefined}>
          {title}
        </Text>
        <Text variant="small" muted>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

/** A small colored dot beside a state, the same one Home uses for presence. */
export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  notice: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: radius.xl + 2,
    padding: space(4),
    gap: space(3),
  },
  noticeHead: { flexDirection: "row", gap: space(3), alignItems: "flex-start" },
  choice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
  },
  radio: {
    marginTop: 2,
    width: 20,
    height: 20,
    borderRadius: radius.full,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 8, height: 8, borderRadius: radius.full },
  dot: { width: 8, height: 8, borderRadius: radius.full },
});
