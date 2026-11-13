import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Toggle } from "@/components/toggle";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

const ICON_TILE = 36;

/** Where the line between settings rows starts: under the text, after the icon. */
export const SETTINGS_INSET = space(4) + ICON_TILE + space(3);

/**
 * A row on the settings page: an icon, what it is, a line about it, and what's on the right (a
 * value, a switch, a spinner). Without `onPress` it only shows something.
 */
export function SettingsRow({
  icon,
  title,
  subtitle,
  aside,
  onPress,
  busy,
  disabled,
  destructive,
  testID,
  accessibilityLabel,
}: {
  icon: (color: string) => ReactNode;
  title: string;
  subtitle?: string | null;
  aside?: ReactNode;
  onPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const ink = destructive ? colors.destructive : colors.foreground;
  const inactive = disabled || busy;
  const body = (
    <>
      <View
        style={[
          styles.tile,
          {
            backgroundColor: destructive
              ? mix(colors.destructive, colors.surface, 0.1)
              : colors.subtle,
          },
        ]}
      >
        {icon(disabled ? colors.mutedForeground : ink)}
      </View>
      <View style={styles.text}>
        <Text variant="label" style={{ color: disabled ? colors.mutedForeground : ink }}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" muted>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {busy ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : aside}
    </>
  );
  if (!onPress)
    return (
      <View
        style={styles.row}
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {body}
      </View>
    );
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      android_ripple={{ color: colors.muted }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

/** A setting that's on or off. The whole row toggles it, not only the switch. */
export function SettingsSwitch({
  value,
  onChange,
  disabled,
  testID,
  ...row
}: {
  icon: (color: string) => ReactNode;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      android_ripple={{ color: colors.muted }}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={row.title}
      testID={testID}
    >
      <SettingsRow
        {...row}
        disabled={disabled}
        aside={
          <Toggle
            value={value}
            onValueChange={onChange}
            disabled={disabled}
            // The row is the control; the switch only shows its state to TalkBack once.
            importantForAccessibility="no-hide-descendants"
          />
        }
      />
    </Pressable>
  );
}

/** A choice of a few, side by side, like Android's segmented buttons. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: { value: T; label: string; icon: (color: string) => ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.segments, { backgroundColor: colors.subtle }]}
      accessibilityRole="radiogroup"
      testID={testID}
    >
      {options.map((option) => {
        const selected = option.value === value;
        // The choice is filled with ink, like a selected filter chip, so it reads at a glance.
        const ink = selected ? colors.primaryForeground : colors.mutedForeground;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            testID={testID ? `${testID}-${option.value}` : undefined}
            style={[
              styles.segment,
              selected && { backgroundColor: colors.primary, borderColor: colors.primary },
            ]}
          >
            {option.icon(ink)}
            <Text variant="small" style={{ color: ink, fontWeight: selected ? "600" : "500" }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  tile: {
    width: ICON_TILE,
    height: ICON_TILE,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, gap: 2 },
  segments: { flexDirection: "row", borderRadius: radius.xl, padding: space(1), gap: space(1) },
  segment: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(1.5),
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "transparent",
  },
});
