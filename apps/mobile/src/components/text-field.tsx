import type { Ref } from "react";
import { StyleSheet, TextInput, type TextInputInstance, type TextInputProps } from "react-native";
import { fonts, radius, space, useColors } from "@/theme";

/** A text box in the app's style. */
export function TextField({
  style,
  mono,
  invalid,
  multiline,
  ref,
  ...props
}: TextInputProps & { mono?: boolean; invalid?: boolean; ref?: Ref<TextInputInstance> }) {
  const colors = useColors();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.mutedForeground}
      cursorColor={colors.foreground}
      selectionColor={colors.input}
      multiline={multiline}
      textAlignVertical={multiline ? "top" : "center"}
      {...props}
      style={[
        styles.input,
        {
          color: colors.foreground,
          backgroundColor: colors.background,
          borderColor: invalid ? colors.destructive : colors.input,
          fontFamily: mono ? fonts.mono : fonts.sans,
          fontSize: mono ? 14 : 15,
        },
        multiline && styles.multiline,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
  },
  multiline: { minHeight: 96, paddingTop: space(3) },
});
