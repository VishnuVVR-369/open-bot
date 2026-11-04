import { Switch, useColorScheme, type SwitchProps } from "react-native";
import { useColors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * An on/off switch in the app's colours. Android's thumb is wider than its track and only a
 * shadow sets it apart from the card, which a dark card swallows, so in the dark the thumb is
 * the light part and the track carries a softer tint of it.
 */
export function Toggle({ value, ...props }: Omit<SwitchProps, "trackColor" | "thumbColor">) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  return (
    <Switch
      value={value}
      trackColor={{
        false: colors.input,
        true: dark ? mix(colors.primary, colors.surface, 0.45) : colors.primary,
      }}
      thumbColor={
        dark
          ? value
            ? colors.primary
            : mix(colors.foreground, colors.surface, 0.7)
          : colors.surface
      }
      {...props}
    />
  );
}
