import { greeting } from "@open-bot/chat-core";
import { router } from "expo-router";
import { Users } from "lucide-react-native";
import { useEffect, useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Briefing } from "@/features/home/components/briefing";
import { Elsewhere } from "@/features/home/components/elsewhere";
import { NeedsYou } from "@/features/home/components/needs-you";
import { Pages } from "@/features/home/components/pages";
import { Teammates } from "@/features/home/components/teammates";
import {
  ComputerOfflineNotice,
  ConnectionNotice,
} from "@/features/computer/components/connection-notice";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { statusLine } from "@/features/home/home";
import { usePresence } from "@/lib/presence";
import { useApprovals } from "@/features/approvals/hooks";
import { useComputerOffline } from "@/features/computer/hooks";
import { useHome } from "@/features/home/hooks";
import { usePages } from "@/features/pages/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { useChats } from "@/features/chat/hooks";
import { takePasswordResetRequest } from "@/lib/password";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { space, useColors } from "@/theme";

export default function HomeScreen() {
  const colors = useColors();
  const home = useHome();
  const teammates = useTeammates();
  const chats = useChats();
  const pages = usePages();
  const computerOffline = useComputerOffline();
  const approvals = useApprovals();
  const pending = useMemo(
    () => approvals.data?.filter((approval) => approval.status === "pending") ?? null,
    [approvals.data],
  );
  const { awaySince } = usePresence();
  // Signed in with a passkey from "Forgot password?": straight on to setting a new one.
  useEffect(() => {
    if (takePasswordResetRequest()) router.push("/settings?password=new");
  }, []);
  const { refreshing, onRefresh } = usePullToRefresh(() =>
    Promise.all([
      home.refetch(),
      teammates.refetch(),
      chats.refetch(),
      pages.refetch(),
      approvals.refetch(),
    ]),
  );

  if (home.isLoading || teammates.isLoading) return <Loading />;
  const error = home.error ?? teammates.error;
  if (error && (!home.data || !teammates.data))
    return (
      <LoadError
        error={error}
        onRetry={() => {
          void home.refetch();
          void teammates.refetch();
        }}
      />
    );
  const data = home.data!;
  const allTeammates = teammates.data ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      testID="home"
    >
      <ConnectionNotice />
      <View style={styles.greeting}>
        <View style={{ gap: space(1) }}>
          <Text variant="title" style={{ fontSize: 30, lineHeight: 36 }}>
            {greeting(data.user.name, new Date().getHours())}
          </Text>
          <Text muted style={{ fontSize: 16, lineHeight: 22 }} testID="home-status">
            {statusLine(data, allTeammates, computerOffline, pending?.length)}
          </Text>
        </View>
        <ComputerOfflineNotice />
      </View>
      <NeedsYou
        home={data}
        approvals={pending}
        teammates={allTeammates}
        computerOffline={computerOffline}
      />
      {awaySince && <Briefing items={data.briefing} teammates={allTeammates} since={awaySince} />}
      {allTeammates.length === 0 ? (
        <Empty
          icon={<Users size={28} color={colors.mutedForeground} />}
          title="No teammates yet"
          body="Create your first teammate in open-bot on a computer."
        />
      ) : (
        <>
          <Teammates
            teammates={allTeammates}
            chats={chats.data ?? []}
            computerOffline={computerOffline}
          />
          <Pages pages={pages.data ?? []} teammates={allTeammates} />
          <Elsewhere
            activity={data.activity}
            teammates={allTeammates}
            computerOffline={computerOffline}
          />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(1), gap: space(7), paddingBottom: space(8) },
  // The greeting sits a little closer to what follows than sections do to each other.
  greeting: { gap: space(4), marginBottom: -space(1) },
});
