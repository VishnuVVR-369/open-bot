import type { ChatSummary } from "@open-bot/api";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
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
export function useChatVisibility(chatId: string, finished: number, historyReady: boolean) {
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const visible = useRef<() => boolean>(() => false);

  const markRead = useCallback(() => {
    // Shown as read right away; the server tells every other device.
    queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (chats) =>
      chats?.map((chat) => (chat.id === chatId && chat.unread ? { ...chat, unread: false } : chat)),
    );
    void api.chats.markRead({ chatId }).catch(() => {});
  }, [chatId, queryClient]);

  useFocusEffect(
    useCallback(() => {
      if (!historyReady) return;
      let focused = true;
      const isVisible = () =>
        focused && navigation.isFocused() && AppState.currentState === "active";
      visible.current = isVisible;
      visibleChat.set(chatId);
      const seen = () => {
        if (!isVisible()) return;
        void clearChatNotifications(chatId, isVisible).catch(() => {});
        markRead();
      };
      seen();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") seen();
      });
      return () => {
        focused = false;
        visible.current = () => false;
        subscription.remove();
        if (visibleChat.get() === chatId) visibleChat.set(null);
      };
    }, [chatId, navigation, markRead, historyReady]),
  );

  const previous = useRef({ chatId, finished });
  useEffect(() => {
    const changed = previous.current.chatId === chatId && previous.current.finished !== finished;
    previous.current = { chatId, finished };
    if (changed && historyReady && visible.current()) markRead();
  }, [chatId, finished, historyReady, markRead]);
}
