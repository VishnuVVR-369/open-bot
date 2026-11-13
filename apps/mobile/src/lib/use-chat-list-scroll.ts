import type { ChatEntry } from "@open-bot/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/**
 * Where the chat's inverted list is scrolled: far enough back to offer a jump to the latest
 * message, and whether older messages sit under the header. Also scrolls to a run, retrying while
 * the list measures the rows on the way. Spread the handlers onto the `FlatList` with `list`.
 */
export function useChatListScroll(chatId: string, runId: string | undefined) {
  const list = useRef<FlatList<ChatEntry>>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  // Older messages sit under the header (the list is inverted, so they're past its far end).
  const [under, setUnder] = useState(false);
  const extent = useRef({ offset: 0, layout: 0, content: 0 });
  const measure = useCallback((next: Partial<typeof extent.current>) => {
    const current = (extent.current = { ...extent.current, ...next });
    setUnder(current.offset + current.layout < current.content - 1);
  }, []);
  const scrollRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAttempts = useRef(0);
  useEffect(
    () => () => {
      if (scrollRetry.current) clearTimeout(scrollRetry.current);
    },
    [chatId, runId],
  );

  const scrollToRun = useCallback((index: number) => {
    scrollAttempts.current = 0;
    requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index, viewPosition: 1, animated: false }),
    );
  }, []);
  const scrollToLatest = () => list.current?.scrollToOffset({ offset: 0, animated: true });

  return {
    list,
    scrolledUp,
    under,
    scrollToRun,
    scrollToLatest,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Inverted: the offset grows as you scroll back in time.
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      const up = contentOffset.y > 600;
      if (up !== scrolledUp) setScrolledUp(up);
      measure({
        offset: contentOffset.y,
        layout: layoutMeasurement.height,
        content: contentSize.height,
      });
    },
    onLayout: (event: { nativeEvent: { layout: { height: number } } }) =>
      measure({ layout: event.nativeEvent.layout.height }),
    onContentSizeChange: (_width: number, height: number) => measure({ content: height }),
    onScrollToIndexFailed: ({
      index,
      averageItemLength,
    }: {
      index: number;
      averageItemLength: number;
    }) => {
      // Move the render window toward an unmeasured row before trying its exact index.
      list.current?.scrollToOffset({
        offset: averageItemLength * index,
        animated: false,
      });
      if (scrollRetry.current) clearTimeout(scrollRetry.current);
      if (scrollAttempts.current++ >= 8) return;
      scrollRetry.current = setTimeout(() => {
        scrollRetry.current = null;
        list.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
      }, 200);
    },
  };
}
