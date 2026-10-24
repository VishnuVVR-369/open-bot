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
import type { NotificationView, StreamRunEvent } from "../types";
import { setTimezone } from "../actions";
import { getJson } from "./api";
import { chatHref, plainText } from "../utils";
import { queryKeys } from "./queries";

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

  const invalidateState = useCallback(() => {
    if (invalidateTimer.current) return;
    invalidateTimer.current = setTimeout(() => {
      invalidateTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.state });
    }, 120);
  }, [queryClient]);

  const onNotification = useCallback(
    async (id: string) => {
      if (seenNotifications.current.has(id)) return;
      seenNotifications.current.add(id);
      const list = await queryClient.fetchQuery({
        queryKey: queryKeys.notifications,
        queryFn: () => getJson<NotificationView[]>("/api/notifications"),
        staleTime: 0,
      });
      const notification = list.find((entry) => entry.id === id);
      if (!notification) return;
      const open = () => {
        if (notification.chatId) router.push(chatHref(notification.chatId, notification.runId));
      };
      // The chat you're looking at already shows what happened, so only other chats get a toast.
      const watching =
        notification.chatId !== null && notification.chatId === visibleChatId && !document.hidden;
      if (!watching) {
        const body = plainText(notification.body);
        toast(notification.title, {
          description: body.length > 140 ? `${body.slice(0, 140)}…` : body,
          action: notification.chatId && !watching ? { label: "Open", onClick: open } : undefined,
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
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("ready", () => {
      setConnected(true);
      // Anything could have changed while disconnected.
      invalidateState();
    });
    source.addEventListener("app", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as {
        type: string;
        id?: string;
      };
      invalidateState();
      if (event.type === "chats") {
        // Runs starting and finishing show up in activity and in automations' history.
        void queryClient.invalidateQueries({ queryKey: queryKeys.activity });
        void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers });
      }
      if (event.type === "notification") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
        if (event.id) void onNotification(event.id);
      }
      if (event.type === "approvals")
        void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
      if (event.type === "schedules")
        void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      if (event.type === "telegram")
        void queryClient.invalidateQueries({ queryKey: queryKeys.telegram });
      if (event.type === "tasks") void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      if (event.type === "lessons") void queryClient.invalidateQueries({ queryKey: ["lessons"] });
      if (event.type === "vault") void queryClient.invalidateQueries({ queryKey: queryKeys.vault });
      if (event.type === "email") void queryClient.invalidateQueries({ queryKey: queryKeys.email });
      if (event.type === "connections")
        void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
      if (event.type === "purchases")
        void queryClient.invalidateQueries({ queryKey: ["spending"] });
      if (event.type === "profile")
        void queryClient.invalidateQueries({ queryKey: queryKeys.profile });
      if (event.type === "triggers")
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers });
      if (event.type === "skills")
        void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
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
    const state = queryClient.getQueryData<{ timezone?: string }>(queryKeys.state);
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (
      state?.timezone === "UTC" &&
      browserZone &&
      browserZone !== "UTC" &&
      !localStorage.getItem("open-bot:timezone-set")
    ) {
      localStorage.setItem("open-bot:timezone-set", "1");
      void setTimezone(browserZone).then(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.state }),
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
