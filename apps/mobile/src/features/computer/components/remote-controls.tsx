import * as Clipboard from "expo-clipboard";
import { Eye, MousePointer2 } from "lucide-react-native";
import type { Dispatch, ReactNode, RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import type { DesktopHandle } from "@/features/computer/components/desktop-view";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import {
  typedChange,
  type ScreenEvent,
  type ScreenSession,
} from "@/features/computer/screen-session";
import { radius, space, useColors } from "@/theme";

const keys = [
  ["Esc", 0xff1b, "Escape"],
  ["Tab", 0xff09, "Tab"],
  ["Ctrl", 0xffe3, "ControlLeft"],
  ["Alt", 0xffe9, "AltLeft"],
  ["←", 0xff51, "ArrowLeft"],
  ["↑", 0xff52, "ArrowUp"],
  ["↓", 0xff54, "ArrowDown"],
  ["→", 0xff53, "ArrowRight"],
  ["Enter", 0xff0d, "Enter"],
] as const;

/**
 * The owner's controls while they hold the screen: the trackpad switch, a key bar whose Ctrl and Alt
 * stay down until pressed again, pasting from the phone, and a field that types into the screen.
 */
export function RemoteControls({
  desktop,
  connected,
  session,
  dispatch,
  fit,
}: {
  desktop: RefObject<DesktopHandle | null>;
  connected: boolean;
  session: ScreenSession;
  dispatch: Dispatch<ScreenEvent>;
  fit: ReactNode;
}) {
  const colors = useColors();
  const { draft, trackpad, held } = session;

  function key(sym: number, code: string, modifier = false) {
    if (!connected) return;
    const down = !held.includes(code);
    desktop.current?.send({ type: "key", keysym: sym, code, ...(modifier ? { down } : {}) });
    if (modifier) dispatch({ type: "hold", code, down });
  }
  function type(value: string) {
    const { backspaces, text } = typedChange(draft, value);
    for (let i = 0; i < backspaces; i++) key(0xff08, "Backspace");
    desktop.current?.send({ type: "text", text });
    dispatch({ type: "typed", draft: value });
  }

  return (
    <>
      <View style={styles.row}>
        <Button
          title={trackpad ? "Touch mode" : "Trackpad"}
          variant="outline"
          icon={<MousePointer2 size={16} color={colors.foreground} />}
          onPress={() => {
            dispatch({ type: "toggle-trackpad" });
            desktop.current?.send({ type: "pointerMode", trackpad: !trackpad });
          }}
          testID="trackpad"
          disabled={!connected}
        />
        {fit}
      </View>
      <View style={[styles.row, { gap: space(1.5) }]}>
        {keys.map(([label, sym, code]) => (
          <Key
            key={code}
            label={label}
            held={held.includes(code)}
            disabled={!connected}
            onPress={() => key(sym, code, label === "Ctrl" || label === "Alt")}
          />
        ))}
        <Key
          label="Paste from phone"
          disabled={!connected}
          onPress={() =>
            void Clipboard.getStringAsync().then((text) =>
              desktop.current?.send({ type: "text", text: text.slice(0, 5000) }),
            )
          }
        />
      </View>
      <TextField
        value={draft}
        editable={connected}
        onChangeText={type}
        placeholder="Keyboard"
        autoCorrect={false}
        autoCapitalize="none"
        onSubmitEditing={() => {
          key(0xff0d, "Enter");
          dispatch({ type: "typed", draft: "" });
        }}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Backspace" && !draft) key(0xff08, "Backspace");
        }}
        testID="remote-keyboard"
      />
      <Text variant="caption" muted>
        {trackpad
          ? "Drag to move the pointer, tap to click where it is."
          : "Tap to click, hold for a right click, and drag with two fingers to scroll."}
      </Text>
    </>
  );
}

/** What a watcher sees under the screen: that watching is harmless, and the Fit button. */
export function WatchHint({ name, fit }: { name: string; fit: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.row, { alignItems: "center" }]}>
      <View style={styles.hint}>
        <Eye size={16} color={colors.mutedForeground} />
        <Text variant="small" muted style={{ flex: 1 }}>
          {`Watching doesn't interrupt ${name}. Pinch to zoom.`}
        </Text>
      </View>
      {fit}
    </View>
  );
}

/** A key on the keyboard bar; Ctrl and Alt stay down until pressed again. */
function Key({
  label,
  held,
  disabled,
  onPress,
}: {
  label: string;
  held?: boolean;
  disabled: boolean;
  onPress: () => void;
}): ReactNode {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: held }}
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: colors.muted, borderless: false }}
      style={[
        styles.key,
        {
          backgroundColor: held ? colors.input : colors.surface,
          borderColor: held ? colors.foreground : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text variant="small">{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: space(2) },
  hint: { flex: 1, flexDirection: "row", alignItems: "center", gap: space(2) },
  key: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: space(3),
    borderWidth: 1,
    borderRadius: radius.md,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
});
