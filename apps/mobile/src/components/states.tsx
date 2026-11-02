import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { errorMessage } from "@/lib/errors";
import { space, useColors } from "@/theme";

/** A screen that's loading, failed to load, or has nothing in it yet. */
export function Loading() {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.mutedForeground} />
    </View>
  );
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <View style={styles.center}>
      <Text variant="heading">Couldn&apos;t load this</Text>
      <Text muted style={styles.body}>
        {errorMessage(error)}
      </Text>
      <Button
        title="Try again"
        variant="outline"
        onPress={onRetry}
        style={{ marginTop: space(2) }}
      />
    </View>
  );
}

export function Empty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <View style={styles.center}>
      {icon}
      <Text variant="heading" style={{ marginTop: space(2) }}>
        {title}
      </Text>
      <Text muted style={styles.body}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space(8),
    gap: space(1.5),
  },
  body: { textAlign: "center", maxWidth: 300 },
});
