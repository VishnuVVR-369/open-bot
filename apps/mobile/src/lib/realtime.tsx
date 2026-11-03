import type { StreamRunEvent } from "@open-bot/api";
import { useQueryClient } from "@tanstack/react-query";
import { fetch as streamingFetch } from "expo/fetch";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { addNetworkStateListener } from "expo-network";
import { AppState } from "react-native";
import { sessionCookie } from "./auth";
import { APP_URL } from "./config";
import { createLiveStream, type LiveStream } from "./live-stream";
import { keysForAppEvent, queryKeys } from "./query";

type RunListener = (event: StreamRunEvent) => void;

interface Realtime {
  /** Follow a chat's run events after `cursor` while the chat is open. */
  watchChat: (chatId: string, cursor: number, listener: RunListener) => () => void;
  /** False while the stream is down, so stale data isn't presented as live. */
  connected: boolean;
}

const Context = createContext<Realtime | null>(null);

/** Which chat you're looking at, so a notification about it isn't shown. */
let visibleChatId: string | null = null;
export const visibleChat = {
  get: () => visibleChatId,
  set: (chatId: string | null) => (visibleChatId = chatId),
};

/**
 * Live updates while the app is in front. App-wide events can't be replayed, so every
 * (re)connection refreshes everything; the open chat resumes from its last run event. Coming back
 * to the app or back online reconnects at once. In the background the stream is closed and push
 * notifications take over.
 */
export function RealtimeProvider({
  children,
  enabled,
  onSignedOut,
}: {
  children: ReactNode;
  /** Only while you're signed in. */
  enabled: boolean;
  onSignedOut: () => void;
}) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const stream = useRef<LiveStream | null>(null);
  const cursors = useRef(new Map<string, number>());
  const target = useRef<{ chatId: string; cursor: number } | null>(null);
  const listeners = useRef(new Map<string, Set<RunListener>>());
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  useEffect(() => {
    if (!enabled) {
      cursors.current.clear();
      return;
    }
    const open = () => {
      stream.current?.close();
      setConnected(false);
      stream.current = createLiveStream({
        cursors: cursors.current,
        appUrl: APP_URL,
        headers: async () => {
          const cookie = await sessionCookie();
          const headers: Record<string, string> = cookie ? { cookie } : {};
          return headers;
        },
        fetch: (url, init) =>
          streamingFetch(url, { headers: init.headers, signal: init.signal, credentials: "omit" }),
        // Anything could have changed while disconnected.
        onReady: () => void queryClient.invalidateQueries(),
        onApp: (event) => {
          for (const queryKey of keysForAppEvent(event.type))
            void queryClient.invalidateQueries({ queryKey });
        },
        onRun: (event) => {
          const chatId = target.current?.chatId;
          if (!chatId) return;
          for (const listener of listeners.current.get(chatId) ?? []) listener(event);
          if (event.payload.type === "status")
            void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
        },
        onConnected: setConnected,
        onUnauthorized: () => signedOut.current(),
      });
      stream.current.watch(target.current);
    };
    open();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") open();
      else if (state === "background") {
        stream.current?.close();
        stream.current = null;
        setConnected(false);
      }
    });
    // Back online: reconnect now instead of waiting out the backoff.
    let online = true;
    const network = addNetworkStateListener(({ isConnected, isInternetReachable }) => {
      const now = isConnected !== false && isInternetReachable !== false;
      if (now && !online && AppState.currentState === "active") open();
      online = now;
    });
    return () => {
      subscription.remove();
      network.remove();
      stream.current?.close();
      stream.current = null;
    };
  }, [enabled, queryClient]);

  const watchChat = useCallback((chatId: string, cursor: number, listener: RunListener) => {
    const set = listeners.current.get(chatId) ?? new Set();
    set.add(listener);
    listeners.current.set(chatId, set);
    const changed = target.current?.chatId !== chatId;
    target.current = {
      chatId,
      cursor: Math.max(cursor, stream.current?.cursorOf(chatId) ?? 0),
    };
    if (changed) stream.current?.watch(target.current);
    return () => {
      set.delete(listener);
      if (set.size === 0 && target.current?.chatId === chatId) {
        target.current = null;
        stream.current?.watch(null);
      }
    };
  }, []);

  const value = useMemo(() => ({ watchChat, connected }), [watchChat, connected]);
  return <Context value={value}>{children}</Context>;
}

export function useRealtime(): Realtime {
  const context = useContext(Context);
  if (!context) throw new Error("useRealtime must be used inside RealtimeProvider");
  return context;
}
