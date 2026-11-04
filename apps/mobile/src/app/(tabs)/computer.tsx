import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Monitor } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, FlatList, RefreshControl, StyleSheet } from "react-native";
import { ScreenCard, type ScreenAction } from "@/components/computer/screen-card";
import { Empty, LoadError, Loading } from "@/components/states";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryClient, queryKeys } from "@/lib/query";
import { screenHref, sortScreens } from "@/lib/screens";
import { space, useColors } from "@/theme";

export default function Computer() {
  const colors = useColors();
  const screens = useQuery({ queryKey: queryKeys.screens, queryFn: () => api.screens.list() });
  // What each screen is in the middle of, so waking one doesn't hold up the others.
  const [pending, setPending] = useState<Record<string, ScreenAction>>({});
  const sorted = useMemo(() => sortScreens(screens.data ?? []), [screens.data]);

  async function act(screenId: string, action: ScreenAction) {
    if (action === "watch" || action === "open") {
      router.push(screenHref(screenId));
      return;
    }
    if (action === "take-over") haptics.press();
    setPending((current) => ({ ...current, [screenId]: action }));
    try {
      if (action === "wake") await api.screens.wake({ screenId });
      else await api.screens.takeOver({ screenId });
      await Promise.all([
        screens.refetch(),
        queryClient.invalidateQueries({ queryKey: queryKeys.home }),
      ]);
      // Taking over is for using the screen, so go straight to it.
      if (action === "take-over") router.push(screenHref(screenId));
    } catch (e) {
      haptics.error();
      Alert.alert("Couldn't change the screen", errorMessage(e));
    } finally {
      setPending(({ [screenId]: _done, ...rest }) => rest);
    }
  }

  if (screens.isLoading) return <Loading />;
  if (screens.error && !screens.data)
    return <LoadError error={screens.error} onRetry={() => void screens.refetch()} />;
  return (
    <FlatList
      data={sorted}
      keyExtractor={(screen) => screen.id}
      testID="screens-list"
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={screens.isRefetching}
          onRefresh={() => void screens.refetch()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      ListEmptyComponent={
        <Empty
          icon={<Monitor size={28} color={colors.mutedForeground} />}
          title="No screens yet"
          body="Every teammate gets their own screen on the shared computer."
        />
      }
      renderItem={({ item }) => (
        <ScreenCard
          screen={item}
          busy={pending[item.id] ?? null}
          onOpen={() => router.push(screenHref(item.id))}
          onAction={(action) => void act(item.id, action)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, padding: space(4), gap: space(3) },
});
