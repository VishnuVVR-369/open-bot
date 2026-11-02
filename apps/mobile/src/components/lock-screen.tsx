import { Fingerprint } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

/** Covers the app until you unlock it with your fingerprint or the phone's PIN. */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const colors = useColors();
  return (
    <View style={[StyleSheet.absoluteFill, styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
        <Fingerprint size={28} color={colors.foreground} />
      </View>
      <Text variant="title">open-bot is locked</Text>
      <Text muted style={{ textAlign: "center" }}>
        Use your fingerprint or screen lock to see your teammates.
      </Text>
      <Button title="Unlock" onPress={onUnlock} style={styles.button} testID="unlock" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: "center", justifyContent: "center", gap: space(2), padding: space(8) },
  mark: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space(3),
  },
  button: { marginTop: space(4), alignSelf: "stretch" },
});
