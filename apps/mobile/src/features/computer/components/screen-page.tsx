import { useQuery } from "@tanstack/react-query";
import { isOwnerLease } from "@open-bot/domain";
import { Stack, useLocalSearchParams } from "expo-router";
import { CloudOff, Moon, Scan } from "lucide-react-native";
import { useCallback, useContext, useEffect, useReducer, useRef, useState } from "react";
import { Alert, Keyboard, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { CodeSheet } from "@/features/computer/components/code-sheet";
import {
  DESKTOP_ASPECT_RATIO,
  DesktopView,
  type DesktopHandle,
} from "@/features/computer/components/desktop-view";
import { HandBackSheet } from "@/features/computer/components/hand-back-sheet";
import { RemoteControls, WatchHint } from "@/features/computer/components/remote-controls";
import {
  ControlNotice,
  ScreenTitle,
  TakeoverNotice,
} from "@/features/computer/components/screen-notice";
import { ScreenMessage, useScreenSurface } from "@/features/computer/components/screen-surface";
import { Loading, LoadError } from "@/components/states";
import { api } from "@/lib/api";
import { ComputerAccess } from "@/features/computer/computer-access";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryKeys } from "@/lib/query";
import {
  reduceScreenSession,
  screenActions,
  screenSession,
  type Pending,
  type ScreenAction,
} from "@/features/computer/screen-session";
import { screenState } from "@/features/computer/screens";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { useHandBackOnLeave, useScreenOrientation } from "@/features/computer/use-screen-page";
import { space, useColors } from "@/theme";

const LANDSCAPE_CONTROLS_WIDTH = 220;
const GUTTER = space(4);

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
  const [connected, setConnected] = useState(false);
  const [session, dispatch] = useReducer(
    reduceScreenSession,
    { takeoverId: takeover ?? null, code: code === "1" },
    screenSession,
  );
  const { pending } = session;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const request = screen?.requests.find((r) => r.id === takeover) ?? screen?.requests[0];

  useEffect(() => {
    dispatch({ type: "link", takeoverId: takeover ?? null, code: code === "1" });
  }, [screenId, takeover, code]);
  useScreenOrientation(owner, landscape);
  useEffect(() => {
    if (!access) dispatch({ type: "access-lost" });
  }, [access]);
  useEffect(() => {
    dispatch({ type: "input-reset" });
  }, [owner, connected]);
  const askHandBack = useCallback(() => dispatch({ type: "ask-hand-back" }), []);
  useHandBackOnLeave(owner, askHandBack);

  async function act(kind: Pending, action: () => Promise<unknown>): Promise<boolean> {
    dispatch({ type: "start", pending: kind });
    try {
      await action();
      await screens.refetch();
      return true;
    } catch (e) {
      haptics.error();
      Alert.alert("Couldn't change the screen", errorMessage(e));
      return false;
    } finally {
      dispatch({ type: "settle" });
    }
  }
  async function returnScreen(clearCode: boolean) {
    const done = await act("hand-back", async () => {
      await api.screens.handBack({ screenId, note: session.note.trim() || null, clearCode });
      dispatch({ type: "handed-back" });
    });
    if (done) haptics.success();
  }
  function press(action: ScreenAction) {
    switch (action.kind) {
      case "hand-back":
        Keyboard.dismiss();
        return askHandBack();
      case "retry":
        return void screens.refetch();
      case "take-over":
        haptics.press();
        return void act("take-over", () => api.screens.takeOver({ screenId }));
      case "wake":
        return void act("wake", () => api.screens.wake({ screenId }));
    }
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
  const actions = screenActions(owner, state);

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
      onTypeCode={() => dispatch({ type: "open-code", takeoverId: request.id })}
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
    <RemoteControls
      desktop={desktop}
      connected={connected}
      session={session}
      dispatch={dispatch}
      fit={fit}
    />
  ) : (
    connected && <WatchHint name={name} fit={fit} />
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
      <HandBackSheet
        open={session.handBack && access}
        onClose={() => dispatch({ type: "cancel-hand-back" })}
        note={session.note}
        onNote={(note) => dispatch({ type: "note", note })}
        busy={pending === "hand-back"}
        canClearCode={
          isOwnerLease(screen.lease) &&
          (screen.lease.kind === "user-code" || screen.lease.pausedForSafety === true)
        }
        onHandBack={(clearCode) => void returnScreen(clearCode)}
      />
      {session.code.takeoverId && (
        <CodeSheet
          screenId={screenId}
          takeoverId={session.code.takeoverId}
          open={session.code.open}
          onClose={() => {
            dispatch({ type: "close-code" });
            void screens.refetch();
          }}
        />
      )}
    </>
  );

  const buttons = (layout: "row" | "column") =>
    actions.map((action) => {
      const actionBusy = action.kind === "retry" ? screens.isRefetching : pending === action.kind;
      return (
        <Button
          key={action.testID}
          title={action.title}
          variant={action.primary ? "primary" : "outline"}
          onPress={() => press(action)}
          busy={actionBusy}
          disabled={busy && !actionBusy}
          testID={action.testID}
          style={layout === "row" ? { flex: 1 } : undefined}
        />
      );
    });

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

const styles = StyleSheet.create({
  landscape: { flex: 1, flexDirection: "row", gap: space(3) },
  stack: { gap: space(3) },
  bar: {
    flexDirection: "row",
    gap: space(3),
    paddingTop: space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
