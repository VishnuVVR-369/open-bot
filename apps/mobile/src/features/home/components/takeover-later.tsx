import type { TeammateSummary, Home } from "@open-bot/api";
import { CloudOff, Hand } from "lucide-react-native";
import { Pressable, View, StyleSheet } from "react-native";
import { TeammateAvatar, needsYouText } from "@/features/teammates/components/teammate-avatar";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { useColors, radius, space } from "@/theme";
import { shared } from "./styles";

/**
 * A takeover while the computer is offline: who needs you and why on one line each, when you
 * can act, and a small way to read the request.
 */
export function TakeoverLater({
  request,
  teammate,
  onOpen,
}: {
  request: Home["takeoverRequests"][number];
  teammate: TeammateSummary | undefined;
  onOpen: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.later, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="takeover-request"
    >
      <View style={styles.laterHead}>
        {teammate ? (
          <TeammateAvatar {...teammate} size="md" activity="waiting" />
        ) : (
          <Hand size={20} color={colors.attentionInk} />
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>
            {request.teammateName} {needsYouText("takeover").toLowerCase()}
          </Text>
          {request.reason ? (
            <Text variant="small" muted numberOfLines={1}>
              {request.reason}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.laterFoot}>
        <View style={[shared.noteTag, { flex: 1 }]}>
          <CloudOff size={13} color={colors.mutedForeground} />
          <Text variant="caption" muted numberOfLines={1} testID="takeover-later">
            When the computer is back
          </Text>
        </View>
        <Pressable
          onPress={() => {
            haptics.tap();
            onOpen();
          }}
          accessibilityRole="button"
          android_ripple={{ color: colors.muted }}
          style={[styles.small, { borderColor: colors.input, backgroundColor: colors.surface }]}
        >
          <Text variant="small" style={{ fontWeight: "600" }}>
            View request
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  later: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(3) },
  laterHead: { flexDirection: "row", alignItems: "center", gap: space(3) },
  // Under the words, past the avatar.
  laterFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingLeft: 36 + space(3),
  },
  small: {
    minHeight: 32,
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
});
