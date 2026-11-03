import type { BotSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Check, ChevronRight, Users } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { ListRow, Separator } from "@/components/list-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/query";
import { useTeammates } from "@/lib/queries";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";

/** Start a chat: with one teammate, or a group of them. */
export default function NewChat() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const queryClient = useQueryClient();
  const { data: bots, error, isLoading, refetch } = useTeammates();
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

  return (
    // The footer stays above the keyboard while you name the group.
    <View style={{ flex: 1, paddingBottom: keyboard }}>
      <Stack.Screen options={{ title: mode === "group" ? "New group" : "New chat" }} />
      <FlatList
        data={bots ?? []}
        keyExtractor={(bot) => bot.id}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={Separator}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space(28) }}
        ListHeaderComponent={
          mode === "direct" ? (
            <View>
              <ListRow
                onPress={() => setMode("group")}
                leading={
                  <View style={[styles.groupMark, { backgroundColor: colors.subtle }]}>
                    <Users size={20} color={colors.foreground} />
                  </View>
                }
                title="New group"
                subtitle="Two or more teammates, working together"
                aside={<ChevronRight size={18} color={colors.mutedForeground} />}
                testID="new-group"
              />
              <Text variant="caption" muted style={styles.overline}>
                CHAT WITH
              </Text>
              {problem && (
                <Text variant="small" style={[styles.problem, { color: colors.destructive }]}>
                  {problem}
                </Text>
              )}
            </View>
          ) : (
            <View style={styles.form}>
              <TextField
                value={title}
                onChangeText={setTitle}
                placeholder="Name the group, like “Trip planning”"
                maxLength={60}
                autoFocus
                testID="group-title"
              />
              <Text variant="caption" muted style={[styles.overline, { paddingHorizontal: 0 }]}>
                {picked.length < 2 ? "PICK AT LEAST TWO TEAMMATES" : `${picked.length} TEAMMATES`}
              </Text>
            </View>
          )
        }
        ListEmptyComponent={
          <Empty
            icon={<Users size={28} color={colors.mutedForeground} />}
            title="No teammates yet"
            body="Create your first teammate in open-bot on a computer."
          />
        }
        renderItem={({ item: bot }) => {
          const selected = picked.includes(bot.id);
          return (
            <ListRow
              onPress={() => (mode === "group" ? toggle(bot.id) : void direct(bot))}
              leading={<BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="lg" />}
              title={bot.name}
              subtitle={bot.role}
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
                  >
                    {selected && (
                      <Check size={14} color={colors.primaryForeground} strokeWidth={3} />
                    )}
                  </View>
                ) : busy === bot.id ? (
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                ) : (
                  <ChevronRight size={18} color={colors.mutedForeground} />
                )
              }
            />
          );
        }}
      />
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
          <View style={{ flexDirection: "row", gap: space(2) }}>
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
  groupMark: {
    width: 48,
    height: 48,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  overline: {
    letterSpacing: 0.6,
    fontWeight: "500",
    paddingHorizontal: space(4),
    paddingTop: space(5),
    paddingBottom: space(1),
  },
  problem: { paddingHorizontal: space(4), paddingBottom: space(2) },
  form: { padding: space(4), paddingBottom: 0, gap: space(1) },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
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
