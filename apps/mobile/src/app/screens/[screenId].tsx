import { useQuery } from "@tanstack/react-query";
import { isOwnerLease } from "@open-bot/domain";
import * as Clipboard from "expo-clipboard";
import * as Orientation from "expo-screen-orientation";
import { Stack, useLocalSearchParams, usePreventRemove } from "expo-router";
import { CloudOff, Eye, Moon, MousePointer2, Scan } from "lucide-react-native";
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
import { ControlNotice, ScreenTitle, TakeoverNotice } from "@/components/computer/screen-notice";
import { ScreenMessage, useScreenSurface } from "@/components/computer/screen-surface";
import { Sheet } from "@/components/sheet";
import { Loading, LoadError } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { ComputerAccess } from "@/lib/computer-access";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryKeys } from "@/lib/query";
import { screenState } from "@/lib/screens";
import { useKeyboardHeight } from "@/lib/use-keyboard";
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

const LANDSCAPE_CONTROLS_WIDTH = 220;
const GUTTER = space(4);

type Pending = "wake" | "take-over" | "hand-back";

interface Action {
  title: string;
  onPress: () => void;
  primary: boolean;
  busy: boolean;
  testID: string;
}

export default function ScreenPage() {
  const { screenId, takeover, code } = useLocalSearchParams<{
    screenId: string;
    takeover?: string;
    code?: string;
  }>();
  const colors = useColors();
  const surface = useScreenSurface();
  const access = useContext(ComputerAccess);
  const screens = useQuery({ queryKey: queryKeys.screens, queryFn: () => api.screens.list() });
  const screen = screens.data?.find((item) => item.id === screenId);
  const owner = isOwnerLease(screen?.lease ?? null);
  const desktop = useRef<DesktopHandle | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
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

  async function act(kind: Pending, action: () => Promise<unknown>): Promise<boolean> {
    setPending(kind);
    try {
      await action();
      await screens.refetch();
      return true;
    } catch (e) {
      haptics.error();
      Alert.alert("Couldn't change the screen", errorMessage(e));
      return false;
    } finally {
      setPending(null);
    }
  }
  function takeOver() {
    haptics.press();
    void act("take-over", () => api.screens.takeOver({ screenId }));
  }
  async function returnScreen(clearCode = false) {
    const done = await act("hand-back", async () => {
      await api.screens.handBack({ screenId, note: note.trim() || null, clearCode });
      setHandBack(false);
      setNote("");
    });
    if (done) haptics.success();
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

  const state = screenState(screen);
  const name = screen.bot.name;
  const live = screen.running && screen.online;
  // The software keyboard needs the room, and you're typing, not reaching for actions.
  const typing = keyboard > 0;
  const busy = pending !== null;

  // One main action, on the right where the thumb is, with at most one quieter one beside it.
  const actions: Action[] = owner
    ? [
        {
          title: "Hand back",
          onPress: () => {
            Keyboard.dismiss();
            setHandBack(true);
          },
          primary: true,
          busy: pending === "hand-back",
          testID: "hand-back",
        },
      ]
    : state.kind === "offline"
      ? [
          {
            title: "Try again",
            onPress: () => void screens.refetch(),
            primary: true,
            busy: screens.isRefetching,
            testID: "retry-screen",
          },
        ]
      : state.kind === "asleep"
        ? [
            {
              title: "Take over",
              onPress: takeOver,
              primary: false,
              busy: pending === "take-over",
              testID: "take-over",
            },
            {
              title: "Wake screen",
              onPress: () => void act("wake", () => api.screens.wake({ screenId })),
              primary: true,
              busy: pending === "wake",
              testID: "wake-screen",
            },
          ]
        : [
            {
              title: "Take over",
              onPress: takeOver,
              primary: true,
              busy: pending === "take-over",
              testID: "take-over",
            },
          ];

  // What the screen shows while there's no stream to show.
  const placeholder = !screen.online ? (
    <ScreenMessage
      icon={<CloudOff size={26} color={surface.ink} />}
      title="Can't reach the computer"
      body="It may be restarting. Try again in a moment."
    />
  ) : pending === "wake" || pending === "take-over" ? (
    <ScreenMessage spinner title="Waking the screen" />
  ) : (
    <ScreenMessage
      icon={<Moon size={26} color={surface.ink} />}
      body="Wake it to watch, or take over to use it yourself."
    />
  );

  const notice = owner ? (
    <ControlNotice name={name} paused={state.kind === "controlling" && state.paused} />
  ) : request ? (
    <TakeoverNotice
      name={name}
      reason={request.reason}
      onTypeCode={() => {
        setCodeTakeover(request.id);
        setShowCode(true);
      }}
    />
  ) : null;

  const fit = connected && (
    <Button
      title="Fit"
      variant="outline"
      icon={<Scan size={16} color={colors.foreground} />}
      onPress={() => desktop.current?.send({ type: "fit" })}
      testID="fit-screen"
    />
  );

  const tools = owner ? (
    <>
      <View style={styles.row}>
        <Button
          title={trackpad ? "Touch mode" : "Trackpad"}
          variant="outline"
          icon={<MousePointer2 size={16} color={colors.foreground} />}
          onPress={() => {
            setTrackpad(!trackpad);
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
          setDraft("");
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
  ) : (
    connected && (
      <View style={[styles.row, { alignItems: "center" }]}>
        <View style={styles.hint}>
          <Eye size={16} color={colors.mutedForeground} />
          <Text variant="small" muted style={{ flex: 1 }}>
            {`Watching doesn't interrupt ${name}. Pinch to zoom.`}
          </Text>
        </View>
        {fit}
      </View>
    )
  );

  const desktopView = (style: object) => (
    <DesktopView
      screenId={screenId}
      enabled={live}
      mode={owner ? "control" : "view"}
      handleRef={desktop}
      onConnectedChange={setConnected}
      placeholder={placeholder}
      style={style}
    />
  );

  const sheets = (
    <>
      <Sheet
        open={handBack && access}
        onClose={() => setHandBack(false)}
        title="Hand the screen back"
        description="Your teammate will take a screenshot and continue."
      >
        <View style={styles.sheetBody}>
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
            busy={pending === "hand-back"}
            testID="hand-back-confirm"
          />
          {isOwnerLease(screen.lease) &&
            (screen.lease.kind === "user-code" || screen.lease.pausedForSafety) && (
              <Button
                title="Clear the code and hand back"
                variant="outline"
                busy={pending === "hand-back"}
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
    </>
  );

  const buttons = (layout: "row" | "column") =>
    actions.map((action) => (
      <Button
        key={action.testID}
        title={action.title}
        variant={action.primary ? "primary" : "outline"}
        onPress={action.onPress}
        busy={action.busy}
        disabled={busy && !action.busy}
        testID={action.testID}
        style={layout === "row" ? { flex: 1 } : undefined}
      />
    ));

  if (landscape) {
    // The header is hidden, so keep clear of the status bar and any cutout, and give the desktop
    // the full height beside a controls column at least this wide.
    const top = insets.top + space(2);
    const bottom = Math.max(insets.bottom, keyboard) + space(2);
    const left = Math.max(insets.left, GUTTER);
    const right = Math.max(insets.right, GUTTER);
    const desktopWidth = Math.min(
      (height - top - bottom) * DESKTOP_ASPECT_RATIO,
      width - left - right - space(3) - LANDSCAPE_CONTROLS_WIDTH,
    );
    return (
      <View
        style={[
          styles.landscape,
          { paddingTop: top, paddingBottom: bottom, paddingLeft: left, paddingRight: right },
        ]}
      >
        <Stack.Screen options={{ title: `${name}'s screen`, headerShown: false }} />
        {desktopView({ width: desktopWidth, height: desktopWidth / DESKTOP_ASPECT_RATIO })}
        <View style={{ flex: 1, gap: space(3) }}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.stack}
            keyboardShouldPersistTaps="always"
          >
            <ScreenTitle screen={screen} />
            {notice}
            {tools}
          </ScrollView>
          {!typing && <View style={styles.stack}>{buttons("column")}</View>}
        </View>
        {sheets}
      </View>
    );
  }

  const left = Math.max(insets.left, GUTTER);
  const right = Math.max(insets.right, GUTTER);
  return (
    <View style={{ flex: 1, paddingBottom: typing ? keyboard : 0 }}>
      <Stack.Screen
        options={{
          title: `${name}'s screen`,
          headerShown: true,
          headerTitle: () => <ScreenTitle screen={screen} />,
        }}
      />
      {/* The desktop stays outside the scroll view so its drags and pinches reach the remote screen. */}
      <View
        style={[styles.stack, { paddingTop: space(3), paddingLeft: left, paddingRight: right }]}
      >
        {notice}
        {desktopView({ aspectRatio: DESKTOP_ASPECT_RATIO })}
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.stack,
          { paddingTop: space(3), paddingBottom: space(4), paddingLeft: left, paddingRight: right },
        ]}
        keyboardShouldPersistTaps="always"
      >
        {tools}
      </ScrollView>
      {!typing && (
        <View
          style={[
            styles.bar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.surface,
              paddingLeft: left,
              paddingRight: right,
              paddingBottom: insets.bottom + space(3),
            },
          ]}
        >
          {buttons("row")}
        </View>
      )}
      {sheets}
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
  landscape: { flex: 1, flexDirection: "row", gap: space(3) },
  stack: { gap: space(3) },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space(2) },
  hint: { flex: 1, flexDirection: "row", alignItems: "center", gap: space(2) },
  bar: {
    flexDirection: "row",
    gap: space(3),
    paddingTop: space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetBody: { paddingHorizontal: space(5), gap: space(3) },
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
