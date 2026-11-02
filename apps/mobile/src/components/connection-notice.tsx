import { WifiOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
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

const styles = StyleSheet.create({
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
