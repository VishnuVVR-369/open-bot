"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
import { toast } from "sonner";
import { parseAppEvent } from "@open-bot/domain";
import { isOutdated } from "../deployment";
import type { NotificationView, StreamRunEvent } from "../types";
import { notificationHref, plainText } from "../utils";
import { deploymentReloader } from "./deployment";
import { refreshAfterOutage, refreshForAppEvent, refreshSnapshots } from "./refresh";
import { attempt } from "./mutate";
import { api, orpc } from "./rpc";

type RunListener = (event: StreamRunEvent) => void;

interface RealtimeContext {
  /** Stream run events of a chat, starting after `cursor`. */
  watchChat: (chatId: string, cursor: number, listener: RunListener) => () => void;
  connected: boolean;
}

const Context = createContext<RealtimeContext | null>(null);

/** Which chat the user is looking at, so notifications about it don't interrupt. */
let visibleChatId: string | null = null;
export function setVisibleChat(chatId: string | null) {
  visibleChatId = chatId;
}

function showDesktopNotification(notification: NotificationView, onClick: () => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const native = new Notification(notification.title, {
    body: plainText(notification.body),
    tag: notification.id,
  });
  native.onclick = () => {
    window.focus();
    onClick();
    native.close();
  };
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [target, setTarget] = useState<{ chatId: string; cursor: number } | null>(null);
  const listeners = useRef(new Map<string, Set<RunListener>>());
  const lastIds = useRef(new Map<string, number>());
  const [connected, setConnected] = useState(false);
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenNotifications = useRef(new Set<string>());
  /** The stream dropped, so the events sent meanwhile were never seen. */
  const missedEvents = useRef(false);

  // Events come in bursts (a run starting touches several things), so the snapshots refresh once.
  const invalidateState = useCallback(() => {
    if (invalidateTimer.current) return;
    invalidateTimer.current = setTimeout(() => {
      invalidateTimer.current = null;
      void refreshSnapshots(queryClient);
    }, 120);
  }, [queryClient]);

  const onNotification = useCallback(
    async (id: string) => {
      if (seenNotifications.current.has(id)) return;
      seenNotifications.current.add(id);
      const list = await queryClient.fetchQuery(
        orpc.notifications.list.queryOptions({ staleTime: 0 }),
      );
      const notification = list.find((entry) => entry.id === id);
      if (!notification) return;
      const href = notificationHref(notification);
      const open = () => {
        if (href) router.push(href);
      };
      // The chat you're looking at already shows what happened, so only other chats get a toast.
      const watching =
        notification.chatId !== null && notification.chatId === visibleChatId && !document.hidden;
      if (!watching) {
        const body = plainText(notification.body);
        toast(notification.title, {
          description: body.length > 140 ? `${body.slice(0, 140)}…` : body,
          action: href && !watching ? { label: "Open", onClick: open } : undefined,
        });
      }
      if (document.hidden || !document.hasFocus()) showDesktopNotification(notification, open);
    },
    [queryClient, router],
  );

  useEffect(() => {
    const params = new URLSearchParams();
    if (target) {
      params.set("chat", target.chatId);
      params.set("after", String(Math.max(target.cursor, lastIds.current.get(target.chatId) ?? 0)));
    }
    const source = new EventSource(`/api/stream?${params}`);
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => {
      setConnected(false);
      missedEvents.current = true;
    });
    source.addEventListener("ready", (message) => {
      const { deployment } = JSON.parse((message as MessageEvent<string>).data) as {
        deployment?: unknown;
      };
      if (isOutdated(deployment)) deploymentReloader().outdated(deployment as string);
      else deploymentReloader().current();
      setConnected(true);
      invalidateState();
      // Anything could have changed while the stream was down, and its events are gone.
      if (missedEvents.current) {
        missedEvents.current = false;
        void refreshAfterOutage(queryClient);
      }
    });
    source.addEventListener("app", (message) => {
      invalidateState();
      // An event this version doesn't know (from a newer server) only refreshes the snapshots.
      const event = parseAppEvent(JSON.parse((message as MessageEvent<string>).data));
      if (!event) return;
      void refreshForAppEvent(queryClient, event);
      if (event.type === "notification" && event.id) void onNotification(event.id);
    });
    source.addEventListener("run", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as StreamRunEvent;
      if (!target) return;
      const last = lastIds.current.get(target.chatId) ?? 0;
      if (event.id <= last) return;
      lastIds.current.set(target.chatId, event.id);
      for (const listener of listeners.current.get(target.chatId) ?? []) listener(event);
      if (event.payload.type === "status") invalidateState();
    });
    return () => source.close();
  }, [target, invalidateState, onNotification, queryClient]);

  useEffect(() => {
    const state = queryClient.getQueryData(orpc.app.state.queryKey());
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (
      state?.timezone === "UTC" &&
      browserZone &&
      browserZone !== "UTC" &&
      !localStorage.getItem("open-bot:timezone-set")
    ) {
      localStorage.setItem("open-bot:timezone-set", "1");
      void attempt(api.settings.setTimezone({ timezone: browserZone })).then(() =>
        queryClient.invalidateQueries({ queryKey: orpc.app.state.key() }),
      );
    }
  }, [queryClient]);

  const watchChat = useCallback((chatId: string, cursor: number, listener: RunListener) => {
    const set = listeners.current.get(chatId) ?? new Set();
    set.add(listener);
    listeners.current.set(chatId, set);
    lastIds.current.set(chatId, Math.max(cursor, lastIds.current.get(chatId) ?? 0));
    setTarget((current) => (current?.chatId === chatId ? current : { chatId, cursor }));
    return () => {
      set.delete(listener);
    };
  }, []);

  const value = useMemo(() => ({ watchChat, connected }), [watchChat, connected]);
  return <Context value={value}>{children}</Context>;
}

export function useRealtime(): RealtimeContext {
  const context = useContext(Context);
  if (!context) throw new Error("useRealtime must be used inside RealtimeProvider");
  return context;
}
