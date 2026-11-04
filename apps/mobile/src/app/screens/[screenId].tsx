import { useQuery } from "@tanstack/react-query";
import { isOwnerLease } from "@open-bot/shared";
import * as Clipboard from "expo-clipboard";
import * as Orientation from "expo-screen-orientation";
import { Stack, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { CodeSheet } from "@/components/computer/code-sheet";
import {
  DESKTOP_ASPECT_RATIO,
  DesktopView,
  type DesktopHandle,
} from "@/components/computer/desktop-view";
import { Sheet } from "@/components/sheet";
import { Loading, LoadError } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { ComputerAccess } from "@/lib/computer-access";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/query";
import { screenStatus } from "@/lib/screens";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { useColors } from "@/theme";

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

const LANDSCAPE_CONTROLS_WIDTH = 220;

export default function ScreenPage() {
  const { screenId, takeover, code } = useLocalSearchParams<{
    screenId: string;
    takeover?: string;
    code?: string;
  }>();
  const colors = useColors();
  const access = useContext(ComputerAccess);
  const screens = useQuery({ queryKey: queryKeys.screens, queryFn: () => api.screens.list() });
  const screen = screens.data?.find((item) => item.id === screenId);
  const owner = isOwnerLease(screen?.lease ?? null);
  const desktop = useRef<DesktopHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [handBack, setHandBack] = useState(false);
  const [showCode, setShowCode] = useState(code === "1");
  const [codeTakeover, setCodeTakeover] = useState<string | null>(takeover ?? null);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");
  const [trackpad, setTrackpad] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const request = screen?.requests.find((r) => r.id === takeover) ?? screen?.requests[0];

  useEffect(() => {
    setCodeTakeover(takeover ?? null);
    setShowCode(code === "1");
  }, [screenId, takeover, code]);

  useEffect(() => {
    const previous = Orientation.getOrientationLockAsync();
    void Orientation.unlockAsync();
    return () => {
      void previous.then((lock) => Orientation.lockAsync(lock));
    };
  }, []);
  // Rotating during a takeover keeps landscape until you hand back or leave.
  useEffect(() => {
    if (owner && landscape) void Orientation.lockAsync(Orientation.OrientationLock.LANDSCAPE);
    else if (!owner) void Orientation.unlockAsync();
  }, [owner, landscape]);
  useEffect(() => {
    if (access) return;
    setShowCode(false);
    setDraft("");
    setHeld([]);
  }, [access]);
  useEffect(() => {
    setTrackpad(false);
    setHeld([]);
    setDraft("");
  }, [owner, connected]);
  const confirmBack = useCallback(() => {
    if (!owner) return false;
    Keyboard.dismiss();
    setHandBack(true);
    return true;
  }, [owner]);
  usePreventRemove(owner, () => {
    confirmBack();
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", confirmBack);
    return () => sub.remove();
  }, [confirmBack]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await screens.refetch();
    } catch (e) {
      Alert.alert("Couldn't change the screen", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function returnScreen(clearCode = false) {
    await act(async () => {
      await api.screens.handBack({ screenId, note: note.trim() || null, clearCode });
      setHandBack(false);
      setNote("");
    });
  }
  function key(sym: number, code: string, modifier = false) {
    if (!connected) return;
    const down = !held.includes(code);
    desktop.current?.send({ type: "key", keysym: sym, code, ...(modifier ? { down } : {}) });
    if (modifier)
      setHeld((previous) =>
        down ? [...previous, code] : previous.filter((value) => value !== code),
      );
  }
  function type(value: string) {
    let prefix = 0;
    while (prefix < value.length && prefix < draft.length && value[prefix] === draft[prefix])
      prefix++;
    for (let i = prefix; i < draft.length; i++) key(0xff08, "Backspace");
    desktop.current?.send({ type: "text", text: value.slice(prefix) });
    setDraft(value);
  }
  if (screens.isLoading) return <Loading />;
  if (!screen)
    return (
      <LoadError
        error={screens.error ?? new Error("That screen is gone.")}
        onRetry={() => void screens.refetch()}
      />
    );
  // In landscape the desktop takes the full height beside a controls column at least this wide.
  const top = landscape ? insets.top + 8 : 8;
  const bottom = Math.max(insets.bottom, keyboard) + 8;
  const left = Math.max(insets.left, 12);
  const right = Math.max(insets.right, 12);
  const desktopWidth = Math.min(
    (height - top - bottom) * DESKTOP_ASPECT_RATIO,
    width - left - right - 10 - LANDSCAPE_CONTROLS_WIDTH,
  );
  const landscapeDesktop = { width: desktopWidth, height: desktopWidth / DESKTOP_ASPECT_RATIO };
  const controls = (
    <>
      {!owner && request && (
        <View style={{ gap: 8 }}>
          <Text variant="small">{request.reason ?? "Your teammate needs you."}</Text>
          <Button
            title="Type the code"
            variant="outline"
            onPress={() => {
              setCodeTakeover(request.id);
              setShowCode(true);
            }}
            testID="type-code"
          />
        </View>
      )}
      <View style={styles.row}>
        {owner ? (
          <>
            <Button
              title="Hand back"
              onPress={() => {
                Keyboard.dismiss();
                setHandBack(true);
              }}
              busy={busy}
              testID="hand-back"
            />
            <Button
              title={trackpad ? "Touch mode" : "Trackpad"}
              variant="outline"
              onPress={() => {
                setTrackpad(!trackpad);
                desktop.current?.send({ type: "pointerMode", trackpad: !trackpad });
              }}
              testID="trackpad"
              disabled={!connected}
            />
          </>
        ) : (
          <>
            <Button
              title="Take over"
              onPress={() => void act(() => api.screens.takeOver({ screenId }))}
              disabled={!screen.online}
              busy={busy}
              testID="take-over"
            />
            {!screen.running && (
              <Button
                title="Wake"
                variant="outline"
                onPress={() => void act(() => api.screens.wake({ screenId }))}
                disabled={!screen.online}
                busy={busy}
                testID="wake-screen"
              />
            )}
          </>
        )}
        <Button
          title="Fit"
          variant="outline"
          onPress={() => desktop.current?.send({ type: "fit" })}
          disabled={!connected}
        />
      </View>
      {owner && (
        <>
          <View style={[styles.row, { gap: 6 }]}>
            {keys.map(([label, sym, code]) => (
              <Pressable
                key={code}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => key(sym, code, label === "Ctrl" || label === "Alt")}
                disabled={!connected}
                style={[
                  styles.key,
                  {
                    backgroundColor: held.includes(code) ? colors.input : colors.surface,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text variant="small">{label}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              disabled={!connected}
              style={[styles.key, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={() =>
                void Clipboard.getStringAsync().then((text) =>
                  desktop.current?.send({ type: "text", text: text.slice(0, 5000) }),
                )
              }
            >
              <Text variant="small">Paste from phone</Text>
            </Pressable>
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
              setDraft("");
            }}
            onKeyPress={(event) => {
              if (event.nativeEvent.key === "Backspace" && !draft) key(0xff08, "Backspace");
            }}
            testID="remote-keyboard"
          />
        </>
      )}
    </>
  );
  return (
    <View
      style={{
        flex: 1,
        // Landscape hides the header, so keep clear of the status bar and any cutout.
        paddingTop: top,
        paddingLeft: left,
        paddingRight: right,
        paddingBottom: bottom,
        gap: 10,
        flexDirection: landscape ? "row" : "column",
      }}
    >
      <Stack.Screen options={{ title: `${screen.bot.name}'s screen`, headerShown: !landscape }} />
      {!landscape && (
        <Text muted variant="small" testID="screen-status">
          {screenStatus(screen)}
        </Text>
      )}
      <DesktopView
        screenId={screenId}
        enabled={screen.running && screen.online}
        mode={owner ? "control" : "view"}
        handleRef={desktop}
        onConnectedChange={setConnected}
        // Fit to width in portrait; full height beside the controls in landscape.
        style={landscape ? landscapeDesktop : { aspectRatio: DESKTOP_ASPECT_RATIO }}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 10 }}
        keyboardShouldPersistTaps="always"
      >
        {landscape && (
          <Text muted variant="small" testID="screen-status">
            {screenStatus(screen)}
          </Text>
        )}
        {controls}
      </ScrollView>
      <Sheet
        open={handBack && access}
        onClose={() => setHandBack(false)}
        title="Hand the screen back"
        description="Your teammate will take a screenshot and continue."
      >
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <TextField
            value={note}
            onChangeText={setNote}
            placeholder="Optional note, such as Logged in, continue"
            multiline
            maxLength={2000}
            testID="hand-back-note"
          />
          <Button
            title="Hand back"
            onPress={() => void returnScreen()}
            busy={busy}
            testID="hand-back-confirm"
          />
          {isOwnerLease(screen.lease) &&
            (screen.lease.kind === "user-code" || screen.lease.pausedForSafety) && (
              <Button
                title="Clear the code and hand back"
                variant="outline"
                busy={busy}
                onPress={() =>
                  Alert.alert(
                    "Clear code and hand back?",
                    "If the computer restarted, this discards all pages on this screen to keep the forgotten code private.",
                    [
                      { text: "Keep control", style: "cancel" },
                      { text: "Clear and hand back", onPress: () => void returnScreen(true) },
                    ],
                  )
                }
                testID="clear-code-hand-back"
              />
            )}
          <Button title="Stay in control" variant="ghost" onPress={() => setHandBack(false)} />
        </View>
      </Sheet>
      {codeTakeover && (
        <CodeSheet
          screenId={screenId}
          takeoverId={codeTakeover}
          open={showCode}
          onClose={() => {
            setShowCode(false);
            setCodeTakeover(null);
            void screens.refetch();
          }}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  key: {
    minHeight: 42,
    minWidth: 42,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
});
