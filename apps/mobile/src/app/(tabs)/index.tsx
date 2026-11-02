import type { BotSummary } from "@open-bot/api";
import { router } from "expo-router";
import { ChevronRight, Users } from "lucide-react-native";
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { BotAvatar, botActivity, botStatusText } from "@/components/bot-avatar";
import { ConnectionNotice } from "@/components/connection-notice";
import { ListRow, Separator } from "@/components/list-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { useNewDirectChat, useTeammates } from "@/lib/queries";
import { useColors } from "@/theme";

/** Your teammates, with what each is doing. Tap one to talk to them. */
export default function Teammates() {
  const colors = useColors();
  const { data, error, isLoading, refetch } = useTeammates();
  const newChat = useNewDirectChat();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const open = (bot: BotSummary) => {
    const chatId = bot.activeRun?.chatId ?? bot.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(bot.id);
  };

  if (isLoading) return <Loading />;
  if (error && !data) return <LoadError error={error} onRetry={() => void refetch()} />;
  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(bot) => bot.id}
      ListHeaderComponent={ConnectionNotice}
      ItemSeparatorComponent={Separator}
      contentContainerStyle={{ flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      ListEmptyComponent={
        <Empty
          icon={<Users size={28} color={colors.mutedForeground} />}
          title="No teammates yet"
          body="Create your first teammate in open-bot on a computer."
        />
      }
      renderItem={({ item: bot }) => {
        const activity = botActivity(bot);
        return (
          <ListRow
            testID="teammate"
            onPress={() => open(bot)}
            leading={
              <BotAvatar
                name={bot.name}
                color={bot.color}
                emoji={bot.emoji}
                size="lg"
                activity={activity}
              />
            }
            title={bot.name}
            subtitle={
              <Text
                variant="small"
                numberOfLines={1}
                muted={activity === "idle" || activity === "queued"}
                style={
                  activity === "waiting"
                    ? { color: colors.waiting }
                    : activity === "working"
                      ? { color: colors.foreground }
                      : undefined
                }
              >
                {botStatusText(bot)}
              </Text>
            }
            aside={
              <View>
                <ChevronRight size={18} color={colors.mutedForeground} />
              </View>
            }
          />
        );
      }}
    />
  );
}
