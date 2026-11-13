import { router } from "expo-router";
import { ChevronRight, CloudOff, WifiOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { useComputerOffline } from "@/features/computer/hooks";
import { useRealtime } from "@/lib/realtime";
import { radius, space, useColors } from "@/theme";

/** Says so when live updates stopped, after a moment, so a quick reconnect doesn't flash. */
export function ConnectionNotice() {
  const colors = useColors();
  const { connected } = useRealtime();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (connected) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), 2500);
    return () => clearTimeout(timer);
  }, [connected]);
  if (!shown) return null;
  return (
    <View style={[styles.notice, { backgroundColor: colors.subtle }]} testID="reconnecting">
      <WifiOff size={14} color={colors.mutedForeground} />
      <Text variant="caption" muted>
        Reconnecting…
      </Text>
    </View>
  );
}

/**
 * One quiet line while the computer is offline, the same on Home and Chats, so nothing on the
 * page looks like work is happening. Opens the Computer tab, which says more.
 */
export function ComputerOfflineNotice({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const offline = useComputerOffline();
  if (!offline) return null;
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.navigate("/computer");
      }}
      accessibilityRole="button"
      accessibilityLabel="Your computer is offline. Work is paused until it's back."
      accessibilityHint="Opens the Computer tab"
      android_ripple={{ color: colors.muted }}
      style={[
        styles.computer,
        { backgroundColor: colors.subtle, borderColor: colors.border },
        style,
      ]}
      testID="computer-offline-notice"
    >
      <CloudOff size={16} color={colors.mutedForeground} />
      <Text variant="small" numberOfLines={1} style={{ flex: 1, fontSize: 14, lineHeight: 19 }}>
        <Text variant="small" style={{ fontSize: 14, fontWeight: "600" }}>
          Computer offline.
        </Text>{" "}
        <Text variant="small" muted style={{ fontSize: 14 }}>
          Work is paused.
        </Text>
      </Text>
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

/**
 * Beside approval buttons while the computer is offline: deciding still works, and this says
 * what approving will really do.
 */
export function ApproveWhileAwayNote({ center = false }: { center?: boolean }) {
  const colors = useColors();
  const offline = useComputerOffline();
  if (!offline) return null;
  return (
    <View style={[styles.away, center && { justifyContent: "center" }]} testID="approve-offline">
      <CloudOff size={13} color={colors.mutedForeground} />
      <Text variant="caption" muted style={{ flexShrink: 1 }}>
        Approved actions run when the computer is back.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  away: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  computer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    minHeight: 44,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: space(3.5),
    paddingRight: space(3),
    paddingVertical: space(2),
    overflow: "hidden",
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: space(1.5),
    borderRadius: radius.full,
    paddingHorizontal: space(3),
    paddingVertical: space(1),
    marginVertical: space(2),
  },
});
