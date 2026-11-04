import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Monitor } from "lucide-react-native";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Loading, LoadError, Empty } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { screenHref, screenStatus } from "@/lib/screens";
import { useColors } from "@/theme";

export default function Computer() {
  const colors = useColors();
  const screens = useQuery({ queryKey: queryKeys.screens, queryFn: () => api.screens.list() });
  if (screens.isLoading) return <Loading />;
  if (screens.error && !screens.data)
    return <LoadError error={screens.error} onRetry={() => void screens.refetch()} />;
  return (
    <FlatList
      data={screens.data}
      keyExtractor={(screen) => screen.id}
      testID="screens-list"
      contentContainerStyle={{ flexGrow: 1, padding: 16, gap: 10 }}
      refreshControl={
        <RefreshControl
          refreshing={screens.isRefetching}
          onRefresh={() => void screens.refetch()}
        />
      }
      ListHeaderComponent={
        <Text muted variant="small" style={{ marginBottom: 8 }}>
          Watch your teammates work, or take over when they need you.
        </Text>
      }
      ListEmptyComponent={
        <Empty
          icon={<Monitor size={28} color={colors.mutedForeground} />}
          title="No screens yet"
          body="Every teammate gets their own screen on the shared computer."
        />
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push(screenHref(item.id))}
          accessibilityRole="button"
          testID={`screen-${item.id}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            borderRadius: 14,
            padding: 16,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <BotAvatar
            {...item.bot}
            activity={item.requests.length ? "waiting" : item.bot.activeRun ? "working" : "idle"}
          />
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="label" numberOfLines={1}>
              {item.bot.name}
            </Text>
            <Text variant="small" muted numberOfLines={1}>
              {screenStatus(item)}
            </Text>
          </View>
          {item.requests.length > 0 && (
            <View
              style={{
                borderRadius: 12,
                backgroundColor: colors.waiting,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Text variant="caption" style={{ color: "white" }}>
                {item.requests.length}
              </Text>
            </View>
          )}
        </Pressable>
      )}
    />
  );
}
