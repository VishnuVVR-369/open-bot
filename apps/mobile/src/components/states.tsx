import type { LucideIcon } from "lucide-react-native";
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

/**
 * Loading failed, but trying again could work (the connection or the server): why, and Try
 * again. With `onBack`, a screen you opened also offers the way back.
 */
export function LoadError({
  error,
  onRetry,
  title = "Couldn't load this",
  onBack,
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
  onBack?: () => void;
}) {
  return (
    <View style={styles.center} testID="load-error">
      <Text variant="heading" style={{ textAlign: "center" }}>
        {title}
      </Text>
      <Text muted style={styles.body}>
        {errorMessage(error)}
      </Text>
      <View style={styles.actions}>
        {onBack && <Button title="Back" variant="outline" onPress={onBack} testID="back" />}
        <Button title="Try again" variant="outline" onPress={onRetry} testID="retry" />
      </View>
    </View>
  );
}

/**
 * Something you opened isn't there (it was archived or deleted, or the link is old). Trying
 * again won't bring it back, so the one action names where it takes you. Chats and teammates
 * share it.
 */
export function NotFound({
  icon: Icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Where the button goes, said plainly: "Go to Chats". */
  action: string;
  onAction: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.center} testID="not-found">
      <View style={[styles.tile, { backgroundColor: colors.subtle, borderColor: colors.border }]}>
        <Icon size={28} color={colors.mutedForeground} />
      </View>
      <Text variant="heading" style={{ marginTop: space(3), textAlign: "center" }}>
        {title}
      </Text>
      <Text muted textBreakStrategy="balanced" style={styles.body}>
        {body}
      </Text>
      <View style={styles.actions}>
        <Button title={action} onPress={onAction} style={styles.wide} testID="not-found-action" />
      </View>
    </View>
  );
}

/** Nothing to show, and why; `action` is what you can do about it. */
export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.center}>
      {icon}
      <Text variant="heading" style={{ marginTop: space(2) }}>
        {title}
      </Text>
      <Text muted style={styles.body}>
        {body}
      </Text>
      {action && <View style={{ marginTop: space(2) }}>{action}</View>}
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
  actions: { flexDirection: "row", gap: space(2.5), marginTop: space(2) },
  tile: {
    width: 64,
    height: 64,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  wide: { minWidth: 160 },
});
