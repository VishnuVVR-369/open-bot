import { safe } from "@orpc/client";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { FileText } from "lucide-react-native";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WebViewMessageEvent } from "react-native-webview";
import { Button } from "@/components/button";
import { AskSheet, type Question } from "@/components/page/ask-sheet";
import { NewerVersion } from "@/components/page/newer-version";
import { PageFrame } from "@/components/page/page-frame";
import { PageActions, PageTitle } from "@/components/page/page-header";
import { PageMenu } from "@/components/page/page-menu";
import { VersionsSheet } from "@/components/page/versions-sheet";
import { Empty, LoadError, Loading } from "@/components/states";
import { api } from "@/lib/api";
import { errorMessage, isGone } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { openOutside } from "@/lib/open-outside";
import { pageSubtitle, parsePageMessage, questionTarget } from "@/lib/pages";
import { queryKeys } from "@/lib/query";
import { useChats } from "@/features/chat/hooks";
import { useTeammates } from "@/lib/queries";
import { usePageFrame } from "@/lib/use-page-frame";
import { usePageVersions } from "@/lib/use-page-versions";
import { useColors } from "@/theme";

/** One page, from its own origin (never with your session), with its versions and Ask. */
export default function PageScreen() {
  const { pageId, v } = useLocalSearchParams<{ pageId: string; v?: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const theme = useColorScheme() === "dark" ? "dark" : "light";
  const page = useQuery({
    queryKey: queryKeys.page(pageId),
    queryFn: () => api.pages.get({ pageId }),
  });
  const teammates = useTeammates();
  const chats = useChats();
  const versions = usePageVersions(page.data, v);
  const { shown } = versions;
  const frame = usePageFrame(shown?.id ?? null, theme, () => void page.refetch());

  const [question, setQuestion] = useState<Question | null>(null);
  const [asking, setAsking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const target = page.data
    ? questionTarget(page.data, teammates.data ?? [], chats.data ?? [])
    : null;
  const teammate = (teammates.data ?? []).find((candidate) => candidate.id === page.data?.botId);

  const ask = useCallback((next: Question) => {
    haptics.tap();
    setQuestion(next);
    setAsking(true);
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parsePageMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "open") void openOutside(message.url);
      else if (target) ask({ quote: message.quote, section: message.section });
    },
    [ask, target],
  );

  const pick = (versionId: string) => {
    if (versions.pick(versionId)) frame.forget();
  };

  const openInBrowser = async () => {
    if (!shown) return;
    const result = await safe(api.pages.open({ versionId: shown.id, theme }));
    if (result.error) Alert.alert("Couldn't open the page", errorMessage(result.error));
    else void openOutside(result.data.url);
  };

  if (page.isLoading) return <Loading />;
  if (page.error && isGone(page.error))
    return (
      <>
        <Stack.Screen options={{ title: "" }} />
        <Empty
          icon={<FileText size={28} color={colors.mutedForeground} />}
          title="This page was deleted"
          body="Its teammate can make it again if you ask."
          action={
            <Button title="All pages" variant="outline" onPress={() => router.navigate("/pages")} />
          }
        />
      </>
    );
  if (page.error || !page.data)
    return <LoadError error={page.error} onRetry={() => void page.refetch()} />;
  const data = page.data;
  const { newer } = versions;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <PageTitle
              title={shown?.title ?? data.title}
              subtitle={pageSubtitle(data, shown, teammate?.name)}
              hasVersions={data.versions.length > 1}
              onVersions={() => setVersionsOpen(true)}
            />
          ),
          headerRight: () => (
            <PageActions
              askName={target ? target.bot.name : null}
              onAsk={() => ask({ quote: null, section: null })}
              onMenu={() => setMenuOpen(true)}
            />
          ),
        }}
      />

      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        {frame.linkError ? (
          <LoadError error={frame.linkError} onRetry={() => void frame.reload(true)} />
        ) : frame.error ? (
          <Empty
            icon={<FileText size={28} color={colors.mutedForeground} />}
            title="Couldn't show this page"
            body={frame.error}
            action={
              <Button title="Try again" variant="outline" onPress={() => void frame.reload(true)} />
            }
          />
        ) : (
          frame.url && (
            <PageFrame
              url={frame.url}
              reloads={frame.reloads}
              onMessage={onMessage}
              onLoadEnd={frame.onLoadEnd}
              onHttpError={frame.onHttpError}
              onError={frame.onError}
              onRenderProcessGone={() => void frame.reload()}
            />
          )
        )}
        {frame.loading && (
          <View
            pointerEvents="none"
            style={[styles.loading, { backgroundColor: colors.background }]}
          >
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        )}
        {newer && (
          <NewerVersion
            number={newer.number}
            onShow={() => pick(newer.id)}
            onDismiss={versions.dismissNewer}
          />
        )}
      </View>

      {target && shown && question && (
        <AskSheet
          open={asking}
          onClose={() => setAsking(false)}
          page={data}
          version={shown.number}
          teammate={target.bot}
          chat={target.chat}
          question={question}
        />
      )}
      {shown && (
        <VersionsSheet
          open={versionsOpen}
          onClose={() => setVersionsOpen(false)}
          page={data}
          shownId={shown.id}
          onPick={pick}
        />
      )}
      <PageMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        page={data}
        onVersions={() => setVersionsOpen(true)}
        onOpenInBrowser={() => void openInBrowser()}
        onChat={target ? () => router.push(chatHref(target.chat.id, shown?.runId)) : null}
        onDeleted={() => (router.canGoBack() ? router.back() : router.navigate("/pages"))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
});
