import { Fingerprint } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppMark } from "@/components/app-mark";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

/** Covers the app until you unlock it with your fingerprint or the phone's PIN. */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        styles.screen,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + space(6),
          paddingBottom: insets.bottom + space(6),
        },
      ]}
    >
      <View style={styles.middle}>
        <AppMark size={76} />
        <View style={styles.words}>
          <Text variant="title" style={styles.title} accessibilityRole="header">
            open-bot is locked
          </Text>
          <Text muted style={styles.body}>
            Use your fingerprint or screen lock to see your teammates.
          </Text>
        </View>
      </View>
      {/* Down where your thumb is. */}
      <Button
        title="Unlock"
        icon={<Fingerprint size={20} color={colors.primaryForeground} />}
        onPress={onUnlock}
        style={styles.button}
        testID="unlock"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: space(6) },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", gap: space(6) },
  words: { alignItems: "center", gap: space(2) },
  title: { fontSize: 26, lineHeight: 32, textAlign: "center" },
  body: { textAlign: "center", maxWidth: 280 },
  button: { alignSelf: "stretch", minHeight: 52 },
});
