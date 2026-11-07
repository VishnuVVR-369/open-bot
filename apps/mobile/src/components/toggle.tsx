import { Switch, useColorScheme, type SwitchProps } from "react-native";
import { useColors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * An on/off switch in the app's colours. Android's thumb is wider than its track and only a
 * shadow sets it apart from the card, which a dark card swallows. So in the dark, on is the
 * bright one (a light track with a white thumb) and off stays dim (a dark track, a grey thumb),
 * and the two never read alike.
 */
export function Toggle({ value, ...props }: Omit<SwitchProps, "trackColor" | "thumbColor">) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  return (
    <Switch
      value={value}
      trackColor={{
        false: colors.input,
        true: dark ? mix(colors.primary, colors.surface, 0.8) : colors.primary,
      }}
      thumbColor={
        dark ? (value ? "#FFFFFF" : mix(colors.foreground, colors.surface, 0.4)) : colors.surface
      }
      {...props}
    />
  );
}
