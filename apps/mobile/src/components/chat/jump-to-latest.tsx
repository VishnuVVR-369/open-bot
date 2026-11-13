import { ArrowDown } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";

/** The round button over a chat scrolled back in time that returns to the latest message. */
export function JumpToLatest({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.latestWrap} pointerEvents="box-none">
      <Pressable
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel="Jump to the latest message"
        android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
        style={[
          styles.latest,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            shadowColor: "#000",
          },
        ]}
        testID="jump-to-latest"
      >
        <ArrowDown size={20} color={colors.foreground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  latestWrap: { position: "absolute", right: space(4), bottom: space(3) },
  latest: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
});
