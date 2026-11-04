import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/text";
import { durations, useReducedMotion } from "@/lib/motion";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { radius, space, useColors } from "@/theme";

/**
 * A panel that slides up from the bottom over a dimmed screen, for choices and short forms. Tap
 * outside it, or Back, to close it. `focusOnShow` is the field to type in: it's focused once the
 * sheet is on screen, since a field focused any earlier doesn't always bring up the keyboard.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  focusOnShow,
  testID,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  focusOnShow?: RefObject<{ focus: () => void } | null>;
  testID?: string;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const scheme = useColorScheme();
  const progress = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  // Stays up after `open` turns false, until the sheet has slid away.
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setShown(true);
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: reduced ? 0 : durations.sheet,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: reduced ? 0 : durations.micro,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setShown(false);
    });
  }, [open, progress, reduced]);

  return (
    <Modal
      visible={shown}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      onShow={() => focusOnShow?.current?.focus()}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          // The screen stays visible behind the sheet, dimmed (more in the dark, to still read as dim).
          {
            backgroundColor: scheme === "dark" ? "rgba(0,0,0,0.6)" : "rgba(10,12,16,0.4)",
            opacity: progress,
          },
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <View style={[styles.anchor, { paddingBottom: keyboard }]} pointerEvents="box-none">
        <Animated.View
          testID={testID}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              paddingBottom: keyboard > 0 ? space(4) : insets.bottom + space(4),
              transform: [
                { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [80, 0] }) },
              ],
              opacity: progress,
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.input }]} />
          {(title || description) && (
            <View style={styles.head}>
              {title && <Text variant="heading">{title}</Text>}
              {description && (
                <Text variant="small" muted>
                  {description}
                </Text>
              )}
            </View>
          )}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A choice in a sheet: an icon and words, tappable across the whole width. */
export function SheetItem({
  icon,
  label,
  onPress,
  destructive,
  disabled,
  testID,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: colors.muted }}
      style={[styles.item, disabled && { opacity: 0.5 }]}
      accessibilityRole="button"
      testID={testID}
    >
      <View style={styles.itemIcon}>{icon}</View>
      <Text variant="label" style={destructive ? { color: colors.destructive } : undefined}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  anchor: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: radius.xl + 6,
    borderTopRightRadius: radius.xl + 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingTop: space(2),
    gap: space(1),
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: space(2),
  },
  head: { paddingHorizontal: space(5), paddingBottom: space(2), gap: space(1) },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    minHeight: 52,
    paddingHorizontal: space(5),
  },
  itemIcon: { width: 22, alignItems: "center" },
});
