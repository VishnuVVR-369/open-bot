import type { ScreenView } from "@open-bot/api";
import { Image } from "expo-image";
import { router } from "expo-router";
import { MonitorOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { Text } from "@/components/text";
import { APP_URL } from "@/lib/config";
import { fileHeaders } from "@/features/files/files";
import { haptics } from "@/lib/haptics";
import { screenHref } from "@/features/computer/screens";
import { lastSeen } from "@/lib/time";
import { radius, space, useColors } from "@/theme";

/** A screenshot a teammate took, as the web serves it; it needs your session, like files do. */
const frameUrl = (artifactId: string) =>
  `${APP_URL}/api/artifacts/${encodeURIComponent(artifactId)}`;

/**
 * While the computer is offline, the last picture of each screen that has one, dimmed and dated,
 * so you can see where each teammate left off (and what a takeover will open on).
 */
export function LastFrames({ screens }: { screens: ScreenView[] }) {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let current = true;
    void fileHeaders().then((value) => current && setHeaders(value));
    return () => {
      current = false;
    };
  }, []);
  const framed = screens.filter((screen) => screen.lastFrame);
  if (framed.length === 0) return null;
  // One picture takes the full width; more sit two to a row.
  const single = framed.length === 1;
  return (
    <View style={styles.grid}>
      {framed.map((screen) => (
        <Frame key={screen.id} screen={screen} headers={headers} wide={single} />
      ))}
    </View>
  );
}

function Frame({
  screen,
  headers,
  wide,
}: {
  screen: ScreenView;
  headers: Record<string, string> | null;
  wide: boolean;
}) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  const [failed, setFailed] = useState(false);
  const frame = screen.lastFrame!;
  const seen = lastSeen(frame.at);
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push(screenHref(screen.id, screen.requests[0]?.id));
      }}
      accessibilityRole="button"
      accessibilityLabel={`${screen.bot.name}'s screen. ${seen}.`}
      style={[styles.cell, wide && styles.wide]}
      testID="last-frame"
    >
      <View
        style={[styles.picture, { backgroundColor: colors.subtle, borderColor: colors.border }]}
      >
        {headers && !failed ? (
          <Image
            source={{ uri: frameUrl(frame.artifactId), headers }}
            style={[StyleSheet.absoluteFill, { opacity: dark ? 0.45 : 0.55 }]}
            contentFit="cover"
            contentPosition="top"
            transition={150}
            recyclingKey={frame.artifactId}
            cachePolicy="disk"
            onError={() => setFailed(true)}
          />
        ) : failed ? (
          <View style={styles.center}>
            <MonitorOff size={20} color={colors.mutedForeground} strokeWidth={1.6} />
          </View>
        ) : null}
      </View>
      <View style={styles.caption}>
        <BotAvatar
          name={screen.bot.name}
          color={screen.bot.color}
          emoji={screen.bot.emoji}
          size="xs"
        />
        <View style={{ flex: 1 }}>
          <Text variant="small" numberOfLines={1} style={{ fontWeight: "500" }}>
            {screen.bot.name}
          </Text>
          <Text variant="caption" muted numberOfLines={1}>
            {seen}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space(3) },
  // Two to a row, with the gap between them.
  cell: { width: "48%", flexGrow: 1, gap: space(2) },
  wide: { width: "100%" },
  picture: {
    aspectRatio: 16 / 10,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  caption: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
