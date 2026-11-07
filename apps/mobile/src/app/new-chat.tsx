import type { BotSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Check, ChevronRight, Users } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activityText, BotAvatar, botActivity } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { ListRow, Separator } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryKeys } from "@/lib/query";
import { useComputerOffline, useTeammates } from "@/lib/queries";
import { lastActive } from "@/lib/time";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { radius, space, useColors } from "@/theme";

/** Start a chat: with one teammate, or a group of them. */
export default function NewChat() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const queryClient = useQueryClient();
  const { data: bots, error, isLoading, refetch } = useTeammates();
  const computerOffline = useComputerOffline();
  const [mode, setMode] = useState<"direct" | "group">("direct");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const opened = (chatId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
    router.replace(`/chats/${chatId}`);
  };

  async function direct(bot: BotSummary) {
    setBusy(bot.id);
    setProblem(null);
    const result = await safe(api.chats.newDirect({ botId: bot.id }));
    setBusy(null);
    if (result.error) setProblem(errorMessage(result.error));
    else opened(result.data.chatId);
  }

  async function group() {
    setBusy("group");
    setProblem(null);
    const result = await safe(api.chats.createGroup({ title: title.trim(), botIds: picked }));
    setBusy(null);
    if (result.error) setProblem(errorMessage(result.error));
    else opened(result.data.chatId);
  }

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );

  if (isLoading) return <Loading />;
  if (error && !bots) return <LoadError error={error} onRetry={() => void refetch()} />;
  const canCreate = title.trim().length > 0 && picked.length >= 2 && busy === null;

  const teammates = bots ?? [];
  const pickers = teammates.map((bot, index) => {
    const selected = picked.includes(bot.id);
    return (
      <View key={bot.id}>
        {index > 0 && <Separator />}
        <ListRow
          onPress={() => {
            haptics.tap();
            if (mode === "group") toggle(bot.id);
            else void direct(bot);
          }}
          leading={
            <BotAvatar
              name={bot.name}
              color={bot.color}
              emoji={bot.emoji}
              size="lg"
              activity={botActivity(bot, computerOffline)}
            />
          }
          title={bot.name}
          // A picker: who they are, unless they're busy with something right now.
          subtitle={
            bot.activeRun && !computerOffline
              ? activityText(botActivity(bot), bot.activeRun.waitingFor)
              : bot.activeRun?.status === "waiting"
                ? activityText("waiting", bot.activeRun.waitingFor)
                : bot.lastActiveAt
                  ? `${bot.role} · ${lastActive(bot.lastActiveAt)}`
                  : bot.role
          }
          testID="pick-teammate"
          aside={
            mode === "group" ? (
              <View
                style={[
                  styles.check,
                  selected
                    ? { backgroundColor: colors.primary, borderColor: colors.primary }
                    : { borderColor: colors.input },
                ]}
                accessible
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={bot.name}
              >
                {selected && <Check size={14} color={colors.primaryForeground} strokeWidth={3} />}
              </View>
            ) : busy === bot.id ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <ChevronRight size={18} color={colors.mutedForeground} />
            )
          }
        />
      </View>
    );
  });

  return (
    // The footer stays above the keyboard while you name the group.
    <View style={{ flex: 1, paddingBottom: keyboard }}>
      <Stack.Screen options={{ title: mode === "group" ? "New group" : "New chat" }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: mode === "group" ? space(36) : space(8) },
        ]}
      >
        {mode === "direct" ? (
          <>
            <Card>
              <ListRow
                onPress={() => {
                  haptics.tap();
                  setMode("group");
                }}
                leading={
                  <View style={[styles.groupMark, { backgroundColor: colors.primary }]}>
                    <Users size={22} color={colors.primaryForeground} />
                  </View>
                }
                title="New group"
                subtitle="A few teammates in one chat"
                aside={<ChevronRight size={18} color={colors.mutedForeground} />}
                testID="new-group"
              />
            </Card>
            {problem && (
              <Text variant="small" style={[styles.problem, { color: colors.destructive }]}>
                {problem}
              </Text>
            )}
            {teammates.length > 0 ? (
              <Section title="Chat with">
                <Card>{pickers}</Card>
              </Section>
            ) : (
              <Empty
                icon={<Users size={28} color={colors.mutedForeground} />}
                title="No teammates yet"
                body="Create your first teammate in open-bot on a computer."
              />
            )}
          </>
        ) : (
          <>
            <View style={{ gap: space(2) }}>
              <Text variant="overline" muted style={styles.overline}>
                Group name
              </Text>
              <TextField
                value={title}
                onChangeText={setTitle}
                placeholder="Like “Trip planning”"
                maxLength={60}
                autoFocus
                testID="group-title"
              />
            </View>
            <Section
              title={
                picked.length < 2 ? "Pick at least two teammates" : `${picked.length} teammates`
              }
            >
              <Card>{pickers}</Card>
            </Section>
          </>
        )}
      </ScrollView>
      {mode === "group" && (
        <View
          style={[
            styles.footer,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              bottom: keyboard,
              paddingBottom: (keyboard > 0 ? 0 : insets.bottom) + space(3),
            },
          ]}
        >
          {problem && (
            <Text variant="small" style={{ color: colors.destructive }}>
              {problem}
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: space(3) }}>
            <Button
              title="Back"
              variant="outline"
              onPress={() => {
                setMode("direct");
                setProblem(null);
              }}
            />
            <Button
              title="Create group"
              onPress={() => void group()}
              disabled={!canCreate}
              busy={busy === "group"}
              style={{ flex: 1 }}
              testID="create-group"
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(6) },
  groupMark: {
    width: 48,
    height: 48,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  overline: { paddingHorizontal: space(1) },
  problem: { paddingHorizontal: space(1) },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space(4),
    paddingTop: space(3),
    gap: space(2),
  },
});
