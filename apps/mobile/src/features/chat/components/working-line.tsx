import type { RunView } from "@open-bot/api";
import { elapsed, workingText } from "@open-bot/chat-core";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { needsYouText } from "@/features/teammates/components/teammate-avatar";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * Under a turn that's still going: what the teammate is doing, with a stopwatch once it takes a
 * while, or what they're waiting on you for.
 */
export function WorkingLine({ run }: { run: RunView }) {
  const colors = useColors();
  const { status, waitingFor } = run.timeline;
  if (status === "waiting") {
    return (
      <View style={styles.working} accessibilityLiveRegion="polite">
        <View style={[styles.dot, { backgroundColor: colors.attention }]} />
        <Text variant="small" style={{ color: colors.attentionInk, fontWeight: "500" }}>
          {needsYouText(waitingFor)}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.working} testID="working" accessibilityLiveRegion="polite">
      {status === "queued" ? (
        <View
          style={[
            styles.dot,
            { backgroundColor: mix(colors.mutedForeground, colors.background, 0.5) },
          ]}
        />
      ) : (
        <ActivityIndicator size={14} color={colors.working} />
      )}
      <Text
        variant="small"
        numberOfLines={1}
        style={{ flexShrink: 1, color: colors.mutedForeground }}
      >
        {status === "queued" ? workingText(run) : `${workingText(run)}…`}
      </Text>
      {status !== "queued" && <Elapsed since={run.createdAt} />}
    </View>
  );
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ms = now - new Date(since).getTime();
  // A quick reply doesn't need a stopwatch.
  if (ms < 10_000) return null;
  return (
    <Text
      variant="mono"
      muted
      style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {elapsed(ms)}
    </Text>
  );
}

const styles = StyleSheet.create({
  working: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 24 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
