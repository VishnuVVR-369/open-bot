import type { ChatSummary } from "@open-bot/api";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { clearChatNotifications } from "../push/notifications";
import { api } from "./api";
import { queryKeys } from "./query";
import { visibleChat } from "./realtime";

/**
 * While you're looking at a chat: notifications about it are cleared and not shown, and it's read
 * (on every device), including replies that finish while it's open. `finished` counts the replies
 * that are done, so a new one marks it read again.
 */
export function useChatVisibility(
  chatId: string,
  finished: number,
  historyVersion: number | null,
  refreshHistory: () => Promise<number>,
) {
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const refresh = useRef<(() => Promise<void>) | null>(null);
  const [caughtUp, setCaughtUp] = useState<{
    version: number;
    isCurrent: () => boolean;
  } | null>(null);

  const markRead = useCallback(() => {
    // Shown as read right away; the server tells every other device.
    queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (chats) =>
      chats?.map((chat) => (chat.id === chatId && chat.unread ? { ...chat, unread: false } : chat)),
    );
    void api.chats.markRead({ chatId }).catch(() => {});
  }, [chatId, queryClient]);

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      let generation = 0;
      let appState = AppState.currentState;
      const isVisible = () =>
        focused && navigation.isFocused() && AppState.currentState === "active";
      const invalidate = () => {
        generation += 1;
        setCaughtUp(null);
        if (visibleChat.get() === chatId) visibleChat.set(null);
      };
      const catchUp = async () => {
        invalidate();
        const started = generation;
        try {
          const version = await refreshHistory();
          const isCurrent = () => started === generation && isVisible();
          if (isCurrent()) setCaughtUp({ version, isCurrent });
        } catch {
          return;
        }
      };
      refresh.current = catchUp;
      if (isVisible()) void catchUp();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === appState) return;
        appState = state;
        if (state === "active" && isVisible()) void catchUp();
        else invalidate();
      });
      return () => {
        focused = false;
        invalidate();
        refresh.current = null;
        subscription.remove();
      };
    }, [chatId, navigation, refreshHistory]),
  );

  useEffect(() => {
    if (!caughtUp || historyVersion === null || historyVersion < caughtUp.version) return;
    let eligible = true;
    const isVisible = () => eligible && caughtUp.isCurrent();
    if (isVisible()) {
      visibleChat.set(chatId);
      void clearChatNotifications(chatId, isVisible).catch(() => {});
      markRead();
    }
    return () => {
      eligible = false;
      if (visibleChat.get() === chatId) visibleChat.set(null);
    };
  }, [chatId, finished, historyVersion, caughtUp, markRead]);

  return useCallback(async () => {
    if (refresh.current) await refresh.current();
    else await refreshHistory();
  }, [refreshHistory]);
}
