import type { ChatStatus } from "@open-bot/domain";
import { router } from "expo-router";
import { ChevronRight, CloudOff } from "lucide-react-native";
import { Pressable, ScrollView, View, StyleSheet } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { useColors, space } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * What's around the chat, under its header: a link to what its teammate needs from you in another
 * chat, and that the computer is offline (a neutral chip, apart from the chat's own status; just
 * "Offline" beside the link, so both fit on a phone).
 */
export function ChatContext({
  computerOffline,
  elsewhere,
}: {
  computerOffline: boolean;
  elsewhere: ChatStatus["elsewhere"];
}) {
  const colors = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.context}
      style={{ flexGrow: 0 }}
      testID="chat-context"
    >
      {elsewhere && (
        <Pressable
          onPress={() => {
            haptics.tap();
            router.push(`/chats/${elsewhere.chatId}`);
          }}
          accessibilityRole="link"
          android_ripple={{ color: mix(colors.attention, colors.surface, 0.18) }}
          style={[
            styles.chip,
            styles.link,
            {
              backgroundColor: mix(colors.attention, colors.surface, 0.1),
              borderColor: mix(colors.attention, colors.surface, 0.4),
            },
          ]}
          testID="elsewhere-chip"
        >
          <View style={[styles.chipDot, { backgroundColor: colors.attention }]} />
          <Text
            variant="caption"
            numberOfLines={1}
            style={{ flexShrink: 1, fontWeight: "500", color: colors.attentionInk }}
          >
            {elsewhere.label}
          </Text>
          <ChevronRight size={14} color={colors.attentionInk} />
        </Pressable>
      )}
      {computerOffline && (
        <Pressable
          onPress={() => router.navigate("/computer")}
          accessibilityRole="button"
          accessibilityHint="Opens the computer"
          android_ripple={{ color: colors.muted }}
          style={[styles.chip, { backgroundColor: colors.subtle, borderColor: colors.border }]}
          testID="computer-offline-chip"
        >
          <CloudOff size={14} color={colors.mutedForeground} />
          <Text variant="caption" muted style={{ fontWeight: "500" }}>
            {elsewhere ? "Offline" : "Computer offline"}
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  context: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(4),
    paddingBottom: space(2),
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    height: 32,
    paddingHorizontal: space(3),
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  // A long chat name ends in an ellipsis, so the offline chip beside it stays in view.
  link: { maxWidth: 300 },
});
