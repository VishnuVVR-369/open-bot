import { Eye, EyeOff } from "lucide-react-native";
import { useState, type ReactNode, type Ref } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { fonts, radius, space, useColors } from "@/theme";

/**
 * A text box in the app's one style, the sign-in screen's: a bordered field that turns ink while
 * you type in it. `password` hides what's typed, with an eye to show it; `trailing` sits at the
 * end, inside the border.
 */
export function TextField({
  style,
  mono,
  invalid,
  multiline,
  password,
  trailing,
  ref,
  onFocus,
  onBlur,
  ...props
}: Omit<TextInputProps, "style"> & {
  /** For the box: a taller multiline field, say. */
  style?: StyleProp<ViewStyle>;
  mono?: boolean;
  invalid?: boolean;
  password?: boolean;
  trailing?: ReactNode;
  ref?: Ref<TextInputInstance>;
}) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  return (
    <View
      style={[
        styles.box,
        multiline && styles.multiline,
        {
          backgroundColor: colors.surface,
          borderColor: invalid ? colors.destructive : focused ? colors.foreground : colors.input,
        },
        style,
      ]}
    >
      <TextInput
        ref={ref}
        placeholderTextColor={colors.mutedForeground}
        cursorColor={colors.foreground}
        selectionColor={colors.input}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        secureTextEntry={password ? !shown : undefined}
        autoCapitalize={password ? "none" : undefined}
        autoCorrect={password ? false : undefined}
        {...props}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          styles.input,
          multiline && styles.multilineInput,
          {
            color: colors.foreground,
            fontFamily: mono ? fonts.mono : fonts.sans,
            fontSize: mono ? 14 : 16,
          },
        ]}
      />
      {password && (
        <Pressable
          onPress={() => setShown((value) => !value)}
          style={styles.reveal}
          accessibilityRole="button"
          accessibilityLabel={shown ? "Hide password" : "Show password"}
          testID={props.testID ? `${props.testID}-reveal` : undefined}
        >
          {shown ? (
            <EyeOff size={18} color={colors.mutedForeground} />
          ) : (
            <Eye size={18} color={colors.mutedForeground} />
          )}
        </Pressable>
      )}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    borderWidth: 1,
    borderRadius: radius.xl,
  },
  multiline: { minHeight: 96, alignItems: "stretch" },
  input: {
    flex: 1,
    alignSelf: "stretch",
    minHeight: 50,
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
  },
  multilineInput: { paddingTop: space(3) },
  reveal: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
});
