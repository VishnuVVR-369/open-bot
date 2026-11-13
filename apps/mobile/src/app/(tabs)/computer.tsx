import type { ScreenView } from "@open-bot/api";
import { router } from "expo-router";
import { ChevronRight, CloudOff, Monitor } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { BotAvatar, StatusLine } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { LastFrames } from "@/components/computer/last-frames";
import { ScreenCard, type ScreenAction } from "@/components/computer/screen-card";
import { ConnectionNotice } from "@/components/connection-notice";
import { ListRow, Separator } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryClient, queryKeys } from "@/lib/query";
import { useScreens } from "@/lib/queries";
import { screenHref, screenState, sortScreens } from "@/lib/screens";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

/** The computer is away: say so once, in words you can act on, instead of on every screen. */
function OfflineBanner({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const colors = useColors();
  return (
    <View
      style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessibilityLiveRegion="polite"
      testID="computer-offline"
    >
      <View style={styles.bannerHead}>
        <View style={[styles.bannerIcon, { backgroundColor: colors.subtle }]}>
          <CloudOff size={20} color={colors.mutedForeground} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">Your computer is offline</Text>
          <Text variant="small" muted>
            Teammates pause computer work until it&apos;s back. Chats and approvals still work.
          </Text>
        </View>
      </View>
      <Button
        title="Check again"
        variant="outline"
        busy={retrying}
        onPress={onRetry}
        testID="computer-retry"
      />
    </View>
  );
}

/**
 * An offline screen, as one quiet row: whose it is and their status in the same words as Home.
 * The banner above says why everyone is paused; a teammate waiting for you still says so, in amber.
 */
function OfflineRow({ screen, first }: { screen: ScreenView; first: boolean }) {
  const colors = useColors();
  const request = screen.requests[0];
  return (
    <>
      {!first && <Separator inset={space(4) + 36 + space(3)} />}
      <ListRow
        onPress={() => router.push(screenHref(screen.id, request?.id))}
        leading={
          <BotAvatar
            name={screen.bot.name}
            color={screen.bot.color}
            emoji={screen.bot.emoji}
            size="md"
          />
        }
        title={screen.bot.name}
        subtitle={
          request ? (
            <StatusLine activity="waiting" waitingFor="takeover" testID="screen-needs-you" />
          ) : (
            <StatusLine activity="paused" testID="screen-paused" />
          )
        }
        aside={<ChevronRight size={18} color={colors.mutedForeground} />}
        testID={`screen-${screen.id}`}
      />
    </>
  );
}

export default function Computer() {
  const colors = useColors();
  const bottom = useSafeBottom({ tabs: true });
  const screens = useScreens();
  const { refreshing, onRefresh } = usePullToRefresh(screens.refetch);
  // What each screen is in the middle of, so waking one doesn't hold up the others.
  const [pending, setPending] = useState<Record<string, ScreenAction>>({});
  const { live, offline } = useMemo(() => {
    const sorted = sortScreens(screens.data ?? []);
    const isOffline = (screen: ScreenView) => screenState(screen).kind === "offline";
    return {
      live: sorted.filter((screen) => !isOffline(screen)),
      offline: sorted.filter(isOffline),
    };
  }, [screens.data]);

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
  const allOffline = live.length === 0 && offline.length > 0;
  return (
    <ScrollView
      testID="screens-list"
      contentContainerStyle={[styles.list, { paddingBottom: bottom }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
    >
      <ConnectionNotice />
      {live.length === 0 && offline.length === 0 && (
        <Empty
          icon={<Monitor size={28} color={colors.mutedForeground} />}
          title="No screens yet"
          body="Every teammate gets their own screen on the shared computer."
        />
      )}
      {allOffline && <OfflineBanner onRetry={() => void onRefresh()} retrying={refreshing} />}
      {live.map((screen) => (
        <ScreenCard
          key={screen.id}
          screen={screen}
          busy={pending[screen.id] ?? null}
          onOpen={() => router.push(screenHref(screen.id))}
          onAction={(action) => void act(screen.id, action)}
        />
      ))}
      {offline.length > 0 && (
        // With nothing live, the banner already says why; the rows only list whose screens.
        <Section title={allOffline ? "Screens" : "Offline"}>
          <Card>
            {offline.map((screen, index) => (
              <OfflineRow key={screen.id} screen={screen} first={index === 0} />
            ))}
          </Card>
        </Section>
      )}
      {allOffline && offline.some((screen) => screen.lastFrame) && (
        <Section title="Last seen">
          <LastFrames screens={offline} />
        </Section>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, padding: space(4), paddingTop: space(2), gap: space(4) },
  banner: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: radius.xl + 2,
    padding: space(4),
    gap: space(4),
  },
  bannerHead: { flexDirection: "row", alignItems: "flex-start", gap: space(3) },
  bannerIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.lg + 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
