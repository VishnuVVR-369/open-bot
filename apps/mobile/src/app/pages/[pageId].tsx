import type { BotSummary, ChatSummary, PageDetail } from "@open-bot/api";
import { pageQuestionText } from "@open-bot/shared";
import { safe } from "@orpc/client";
import { useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  Check,
  ChevronDown,
  EllipsisVertical,
  ExternalLink,
  FileText,
  History,
  MessageSquare,
  MessageSquareText,
  Pin,
  PinOff,
  Send,
  Trash2,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TextInputInstance } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Button } from "@/components/button";
import { confirmDeletePage, setPagePinned } from "@/components/page-row";
import { Sheet, SheetItem } from "@/components/sheet";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage, isGone } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { isLinkFresh, parsePageMessage, questionTarget } from "@/lib/pages";
import { queryClient, queryKeys } from "@/lib/query";
import { useChats, useTeammates } from "@/lib/queries";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";

interface Question {
  quote: string | null;
  section: string | null;
}

/** Opens a link from a page outside the app: web links in a browser tab, mail in the mail app. */
async function openOutside(url: string) {
  try {
    if (url.startsWith("mailto:")) await Linking.openURL(url);
    else await WebBrowser.openBrowserAsync(url);
  } catch {
    Alert.alert("Couldn't open the link", url);
  }
}

function AskSheet({
  open,
  onClose,
  page,
  version,
  bot,
  chat,
  question,
}: {
  open: boolean;
  onClose: () => void;
  page: PageDetail;
  version: number;
  bot: BotSummary;
  chat: ChatSummary;
  question: Question;
}) {
  const colors = useColors();
  const input = useRef<TextInputInstance>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // The same id for every try of one question, so a retry after a lost answer isn't sent twice.
  const clientId = useRef(Crypto.randomUUID());

  const send = async () => {
    const draft = text.trim();
    if (!draft || sending) return;
    setSending(true);
    const result = await safe(
      api.chats.send({
        clientId: clientId.current,
        chatId: chat.id,
        text: pageQuestionText({
          pageId: page.id,
          title: page.title,
          version,
          quote: question.quote,
          section: question.section,
          text: draft,
        }),
        attachments: [],
        mentions: chat.kind === "group" ? [bot.id] : [],
      }),
    );
    setSending(false);
    if (result.error) {
      Alert.alert("Couldn't send", errorMessage(result.error));
      return;
    }
    haptics.success();
    clientId.current = Crypto.randomUUID();
    setText("");
    onClose();
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
    Alert.alert(
      `Sent to ${bot.name}`,
      "Their answer shows in the chat. If they change the page, the new version shows here.",
      [
        { text: "Stay here", style: "cancel" },
        { text: "Open chat", onPress: () => router.push(chatHref(chat.id)) },
      ],
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Ask ${bot.name}`}
      description={
        chat.kind === "group" ? `Goes to ${chat.title}` : `Goes to your chat with ${bot.name}`
      }
      focusOnShow={input}
      testID="page-ask"
    >
      <View style={styles.askBody}>
        {question.quote && (
          <View style={[styles.quote, { borderColor: colors.input }]}>
            {question.section && (
              <Text variant="overline" muted numberOfLines={1}>
                {question.section}
              </Text>
            )}
            <Text variant="small" muted numberOfLines={4}>
              {question.quote}
            </Text>
          </View>
        )}
        <TextField
          ref={input}
          value={text}
          onChangeText={setText}
          multiline
          placeholder={
            question.quote
              ? "What would you like to know about this?"
              : "Ask a question or ask for a change"
          }
          accessibilityLabel="Your question"
          testID="page-ask-input"
        />
        <Button
          title="Send"
          icon={<Send size={16} color={colors.primaryForeground} />}
          onPress={() => void send()}
          disabled={!text.trim()}
          busy={sending}
          testID="page-ask-send"
        />
      </View>
    </Sheet>
  );
}

function VersionsSheet({
  open,
  onClose,
  page,
  shownId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  page: PageDetail;
  shownId: string;
  onPick: (versionId: string) => void;
}) {
  const colors = useColors();
  return (
    <Sheet open={open} onClose={onClose} title="Versions" testID="page-versions">
      <ScrollView style={{ maxHeight: 420 }}>
        {page.versions.map((version) => (
          <Pressable
            key={version.id}
            onPress={() => {
              onClose();
              onPick(version.id);
            }}
            android_ripple={{ color: colors.muted }}
            accessibilityRole="button"
            accessibilityState={{ selected: version.id === shownId }}
            style={styles.version}
            testID="page-version"
          >
            <View style={styles.versionCheck}>
              {version.id === shownId && <Check size={18} color={colors.foreground} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.versionTitle}>
                <Text variant="label">Version {version.number}</Text>
                {version.id === page.versionId && (
                  <View style={[styles.badge, { backgroundColor: colors.subtle }]}>
                    <Text variant="caption" muted style={{ fontWeight: "500" }}>
                      Latest
                    </Text>
                  </View>
                )}
              </View>
              {version.note ? (
                <Text variant="small" muted numberOfLines={2}>
                  {version.note}
                </Text>
              ) : null}
              <Text variant="caption" muted>
                {ago(version.createdAt)}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </Sheet>
  );
}

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

  // The version on screen, and the newest one you know about: a newer one offers itself.
  const [shownId, setShownId] = useState<string | null>(null);
  const [knownLatest, setKnownLatest] = useState<string | null>(null);
  useEffect(() => {
    if (!page.data || shownId) return;
    const asked = v && page.data.versions.some((version) => version.id === v);
    setShownId(asked ? v : page.data.versionId);
    setKnownLatest(page.data.versionId);
  }, [page.data, shownId, v]);
  const shown = page.data?.versions.find((version) => version.id === shownId) ?? null;

  const link = useQuery({
    queryKey: queryKeys.pageLink(shown?.id ?? "", theme),
    queryFn: () => api.pages.open({ versionId: shown!.id, theme, ask: true }),
    enabled: shown !== null,
    // Loaded once into the page; a fresh one is only needed to load it again.
    staleTime: Infinity,
    gcTime: 60_000,
  });
  // The link the page is showing. It only changes with the version or the theme, or when you
  // load the page again: a new link for the same page (say, after the app reconnects and
  // refreshes everything) would otherwise reload it and lose your place.
  const frameKey = shown ? `${shown.id}|${theme}` : null;
  const [frame, setFrame] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!frameKey || !link.data) return;
    const next = { key: frameKey, url: link.data.url };
    setFrame((current) => (current?.key === frameKey ? current : next));
  }, [frameKey, link.data]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // A link the pages service turned down gets one new link by itself; after that, you decide.
  const retriedExpired = useRef(false);

  /** Load the page again, with a new link if this one is out (or nearly), or `fresh` asks. */
  const reload = useCallback(
    async (fresh = false) => {
      setFrameError(null);
      let next = link.data;
      if (fresh || !next || !isLinkFresh(next)) next = (await link.refetch()).data;
      if (next && frameKey) setFrame({ key: frameKey, url: next.url });
      setReloads((n) => n + 1);
    },
    [link, frameKey],
  );

  const [question, setQuestion] = useState<Question | null>(null);
  const [asking, setAsking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const target = page.data
    ? questionTarget(page.data, teammates.data ?? [], chats.data ?? [])
    : null;
  const bot = (teammates.data ?? []).find((candidate) => candidate.id === page.data?.botId);

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
    if (!page.data) return;
    haptics.tap();
    setShownId(versionId);
    setKnownLatest(page.data.versionId);
    setLoadedUrl(null);
    router.setParams({ v: versionId === page.data.versionId ? undefined : versionId });
  };

  const openInBrowser = async () => {
    if (!shown) return;
    const result = await safe(api.pages.open({ versionId: shown.id, theme }));
    if (result.error) Alert.alert("Couldn't open the page", errorMessage(result.error));
    else void openOutside(result.data.url);
  };

  const newer = useMemo(() => {
    const data = page.data;
    if (!data || !shown || data.versionId === shown.id || data.versionId === knownLatest)
      return null;
    return data.versions[0] ?? null;
  }, [page.data, shown, knownLatest]);

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
  const url = frame && frame.key === frameKey ? frame.url : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable
              onPress={() => data.versions.length > 1 && setVersionsOpen(true)}
              disabled={data.versions.length < 2}
              accessibilityRole={data.versions.length > 1 ? "button" : undefined}
              accessibilityHint={data.versions.length > 1 ? "Shows its versions" : undefined}
              style={styles.headerTitle}
              testID="page-header"
            >
              <Text variant="heading" numberOfLines={1} style={{ fontSize: 16, lineHeight: 20 }}>
                {shown?.title ?? data.title}
              </Text>
              <View style={styles.headerMeta}>
                <Text variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
                  {[
                    bot?.name ?? "Former teammate",
                    shown
                      ? data.versions.length > 1
                        ? `Version ${shown.number}${shown.id !== data.versionId ? " (older)" : ""}`
                        : ago(shown.createdAt)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                {data.versions.length > 1 && (
                  <ChevronDown size={12} color={colors.mutedForeground} />
                )}
              </View>
            </Pressable>
          ),
          headerRight: () => (
            <View style={styles.headerActions}>
              {target && (
                <Pressable
                  onPress={() => ask({ quote: null, section: null })}
                  accessibilityRole="button"
                  accessibilityLabel={`Ask ${target.bot.name} about this page`}
                  android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
                  style={styles.headerButton}
                  testID="page-ask-open"
                >
                  <MessageSquare size={21} color={colors.foreground} />
                </Pressable>
              )}
              <Pressable
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Page options"
                android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
                style={styles.headerButton}
                testID="page-menu-open"
              >
                <EllipsisVertical size={22} color={colors.foreground} />
              </Pressable>
            </View>
          ),
        }}
      />

      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        {link.error ? (
          <LoadError error={link.error} onRetry={() => void reload(true)} />
        ) : frameError ? (
          <Empty
            icon={<FileText size={28} color={colors.mutedForeground} />}
            title="Couldn't show this page"
            body={frameError}
            action={
              <Button title="Try again" variant="outline" onPress={() => void reload(true)} />
            }
          />
        ) : (
          url && (
            <WebView
              key={`${url}#${reloads}`}
              source={{ uri: url }}
              onMessage={onMessage}
              // Only the page itself loads here; any other address opens outside the app.
              onShouldStartLoadWithRequest={(request) => {
                // The page itself, or a place in it (its table of contents).
                if (request.url.split("#")[0] === url || request.url === "about:blank") return true;
                if (!request.isTopFrame) return false;
                const message = parsePageMessage(
                  JSON.stringify({ source: "openbot-page", type: "open", url: request.url }),
                );
                if (message?.type === "open") void openOutside(message.url);
                return false;
              }}
              setSupportMultipleWindows={false}
              javaScriptCanOpenWindowsAutomatically={false}
              // Never your session: the page runs on its own origin with nothing of yours.
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              incognito
              domStorageEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              geolocationEnabled={false}
              mediaPlaybackRequiresUserAction
              mixedContentMode={__DEV__ ? "compatibility" : "never"}
              forceDarkOn={false}
              overScrollMode="never"
              onLoadEnd={() => setLoadedUrl(url)}
              onHttpError={(event) => {
                const status = event.nativeEvent.statusCode;
                // An expired link: get a new one and load again, once.
                if (status === 403 && !retriedExpired.current) {
                  retriedExpired.current = true;
                  void reload(true);
                } else if (status === 404) void page.refetch();
                else
                  setFrameError(
                    status === 403
                      ? "The link to this page expired. Try again for a new one."
                      : "open-bot's pages service didn't answer. Try again in a moment.",
                  );
              }}
              onError={() =>
                setFrameError("Couldn't reach open-bot's pages service. Check your connection.")
              }
              onRenderProcessGone={(): void => {
                void reload();
              }}
              style={{ flex: 1, backgroundColor: colors.background }}
              containerStyle={{ backgroundColor: colors.background }}
              testID="page-webview"
            />
          )
        )}
        {!link.error && !frameError && loadedUrl !== url && (
          <View
            pointerEvents="none"
            style={[styles.loading, { backgroundColor: colors.background }]}
          >
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        )}
        {newer && (
          <View style={styles.newerWrap} pointerEvents="box-none">
            <View
              style={[
                styles.newer,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
              testID="page-newer"
            >
              <Text variant="small" style={{ fontWeight: "500" }}>
                Version {newer.number} is ready
              </Text>
              <Pressable
                onPress={() => pick(newer.id)}
                accessibilityRole="button"
                style={[styles.newerShow, { backgroundColor: colors.primary }]}
              >
                <Text
                  variant="small"
                  style={{ color: colors.primaryForeground, fontWeight: "600" }}
                >
                  Show it
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setKnownLatest(data.versionId)}
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
                hitSlop={8}
                style={styles.newerDismiss}
              >
                <X size={16} color={colors.mutedForeground} />
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {target && shown && question && (
        <AskSheet
          open={asking}
          onClose={() => setAsking(false)}
          page={data}
          version={shown.number}
          bot={target.bot}
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
      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={data.title}
        testID="page-options"
      >
        {data.versions.length > 1 && (
          <SheetItem
            icon={<History size={20} color={colors.foreground} />}
            label="Versions"
            onPress={() => {
              setMenuOpen(false);
              setVersionsOpen(true);
            }}
          />
        )}
        <SheetItem
          icon={<ExternalLink size={20} color={colors.foreground} />}
          label="Open in the browser"
          onPress={() => {
            setMenuOpen(false);
            void openInBrowser();
          }}
          testID="page-open-browser"
        />
        {target && (
          <SheetItem
            icon={<MessageSquareText size={20} color={colors.foreground} />}
            label="Go to the chat"
            onPress={() => {
              setMenuOpen(false);
              router.push(chatHref(target.chat.id, shown?.runId));
            }}
          />
        )}
        <SheetItem
          icon={
            data.pinned ? (
              <PinOff size={20} color={colors.foreground} />
            ) : (
              <Pin size={20} color={colors.foreground} />
            )
          }
          label={data.pinned ? "Unpin" : "Pin to top"}
          onPress={() => {
            setMenuOpen(false);
            void setPagePinned(data, !data.pinned);
          }}
        />
        <SheetItem
          icon={<Trash2 size={20} color={colors.destructive} />}
          label="Delete"
          destructive
          onPress={() => {
            setMenuOpen(false);
            confirmDeletePage(data, () =>
              router.canGoBack() ? router.back() : router.navigate("/pages"),
            );
          }}
          testID="page-delete"
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { maxWidth: 240, gap: 1 },
  headerMeta: { flexDirection: "row", alignItems: "center", gap: 3 },
  headerActions: { flexDirection: "row", alignItems: "center", marginRight: -space(2) },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  newerWrap: {
    position: "absolute",
    top: space(3),
    left: 0,
    right: 0,
    alignItems: "center",
  },
  newer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.full,
    paddingLeft: space(4),
    paddingRight: space(1.5),
    paddingVertical: space(1.5),
    elevation: 4,
    shadowColor: "#000000",
  },
  newerShow: {
    borderRadius: radius.full,
    paddingHorizontal: space(3),
    minHeight: 30,
    justifyContent: "center",
  },
  newerDismiss: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  askBody: { paddingHorizontal: space(5), gap: space(3), paddingTop: space(1) },
  quote: { borderLeftWidth: 2, paddingLeft: space(3), gap: 2 },
  version: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(5),
    paddingVertical: space(3),
  },
  versionCheck: { width: 22, alignItems: "center", paddingTop: 1 },
  versionTitle: { flexDirection: "row", alignItems: "center", gap: space(2) },
  badge: { borderRadius: 5, paddingHorizontal: 6 },
});
