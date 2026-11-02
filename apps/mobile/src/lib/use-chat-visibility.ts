import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback } from "react";
import { AppState } from "react-native";
import { clearChatNotifications } from "../push/notifications";
import { visibleChat } from "./realtime";

export function useChatVisibility(chatId: string) {
  const navigation = useNavigation();
  useFocusEffect(
    useCallback(() => {
      let focused = true;
      const isVisible = () =>
        focused && navigation.isFocused() && AppState.currentState === "active";
      visibleChat.set(chatId);
      const clear = () => {
        if (isVisible()) void clearChatNotifications(chatId, isVisible).catch(() => {});
      };
      clear();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") clear();
      });
      return () => {
        focused = false;
        subscription.remove();
        if (visibleChat.get() === chatId) visibleChat.set(null);
      };
    }, [chatId, navigation]),
  );
}
