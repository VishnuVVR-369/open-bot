import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { viewerHtml } from "@/computer/viewer-html";
import { api } from "@/lib/api";
import { sessionCookie } from "@/lib/auth";
import { ComputerAccess } from "@/lib/computer-access";
import { APP_URL } from "@/lib/config";
import { queryClient, queryKeys } from "@/lib/query";
import { radius } from "@/theme";
import { ScreenMessage, useScreenSurface } from "./screen-surface";

/** Every screen is 1280x800, so a view this shape shows it edge to edge. */
export const DESKTOP_ASPECT_RATIO = 1280 / 800;

export interface DesktopHandle {
  send: (message: Record<string, unknown>) => void;
}

export function DesktopView({
  screenId,
  mode,
  enabled,
  handleRef,
  onConnectedChange,
  placeholder,
  style,
}: {
  screenId: string;
  mode: "view" | "control";
  enabled: boolean;
  handleRef?: React.RefObject<DesktopHandle | null>;
  onConnectedChange?: (connected: boolean) => void;
  /** What to show while there's no stream, such as an asleep or offline screen. */
  placeholder?: React.ReactNode;
  /** Size it: a fixed aspect ratio, or `flex: 1` to fill the space around it. */
  style?: StyleProp<ViewStyle>;
}) {
  const web = useRef<WebView<object>>(null);
  const access = useContext(ComputerAccess);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [ready, setReady] = useState(0);
  const [documentKey, setDocumentKey] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"Connecting" | "Connected" | "Reconnecting" | "Unavailable">(
    "Connecting",
  );
  const surface = useScreenSurface();
  const generation = useRef(0);
  const lastActivity = useRef(0);
  // Whether this screen has shown at all, so a first try that fails still reads "Connecting".
  const shown = useRef(false);
  const retrying = () => (shown.current ? "Reconnecting" : "Connecting");
  const alive = enabled && access && foreground;
  useEffect(() => {
    onConnectedChange?.(alive && status === "Connected");
  }, [alive, status, onConnectedChange]);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useCallback((message: Record<string, unknown>) => {
    web.current?.postMessage(
      JSON.stringify({ ...message, version: 1, generation: generation.current }),
    );
  }, []);

  useEffect(() => {
    if (handleRef) handleRef.current = { send };
    return () => {
      if (handleRef) handleRef.current = null;
    };
  }, [handleRef, send]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    let disposed = false;
    if (!alive || !ready) return;
    setStatus(retrying());
    void (async () => {
      try {
        const cookie = await sessionCookie();
        const response = await fetch(`${APP_URL}/api/desktop/token`, {
          headers: cookie ? { cookie } : {},
          credentials: "omit",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("No token");
        const { url, token } = (await response.json()) as { url: string; token: string };
        if (disposed || generation.current !== current) return;
        if (!__DEV__ && !url.startsWith("wss://")) throw new Error("Secure connection required");
        send({ type: "connect", url, token, screenId, mode });
      } catch {
        if (disposed) return;
        setStatus("Unavailable");
        if (mode === "control") retry.current = setTimeout(() => setAttempt((n) => n + 1), 3000);
      }
    })();
    return () => {
      disposed = true;
      if (retry.current) clearTimeout(retry.current);
      send({ type: "disconnect" });
    };
  }, [screenId, mode, alive, ready, attempt, send]);

  function onMessage(event: WebViewMessageEvent) {
    let data: { version?: number; generation?: number; type?: string };
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (data.version !== 1) return;
    if (data.type === "ready") {
      setReady((n) => n + 1);
      return;
    }
    if (!alive || data.generation !== generation.current) return;
    if (data.type === "connected") {
      shown.current = true;
      setStatus("Connected");
    }
    if (data.type === "disconnected") {
      setStatus(retrying());
      void queryClient.invalidateQueries({ queryKey: queryKeys.screens });
      if (retry.current) clearTimeout(retry.current);
      if (mode === "control") retry.current = setTimeout(() => setAttempt((n) => n + 1), 2000);
    }
    if (
      data.type === "activity" &&
      mode === "control" &&
      Date.now() - lastActivity.current > 30_000
    ) {
      lastActivity.current = Date.now();
      void api.screens.activity({ screenId }).catch(() => {});
    }
  }
  return (
    <View
      style={[
        styles.host,
        { backgroundColor: surface.background, borderColor: surface.border },
        style,
      ]}
      testID="desktop-view"
    >
      {alive && (
        <WebView<object>
          key={documentKey}
          ref={web}
          source={{ html: viewerHtml }}
          originWhitelist={["*"]}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
          onOpenWindow={() => {}}
          javaScriptCanOpenWindowsAutomatically={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode={__DEV__ ? "compatibility" : "never"}
          scrollEnabled={false}
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          onRenderProcessGone={() => {
            setStatus(retrying());
            setReady(0);
            setDocumentKey((n) => n + 1);
          }}
          style={styles.web}
          testID="computer-webview"
        />
      )}
      {/* Covers the viewer until the first frame, so connecting never looks like a blank screen. */}
      {(!alive || status !== "Connected") && (
        <View
          pointerEvents="none"
          style={[styles.overlay, { backgroundColor: surface.background }]}
        >
          {alive ? (
            status === "Unavailable" ? (
              <ScreenMessage spinner title="Can't reach the screen" body="Trying again" />
            ) : (
              <ScreenMessage spinner title={status} />
            )
          ) : (
            (placeholder ?? (
              <ScreenMessage title={enabled ? "Screen paused" : "Screen is asleep"} />
            ))
          )}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  host: {
    width: "100%",
    overflow: "hidden",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  // The bundled viewer paints this behind the remote desktop, so the edges match while it loads.
  web: { flex: 1, backgroundColor: "#101117" },
  overlay: { ...StyleSheet.absoluteFill },
});
