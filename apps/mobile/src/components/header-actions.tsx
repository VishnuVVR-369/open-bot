import { router } from "expo-router";
import { Bell, Search, Settings } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useHome } from "@/lib/queries";
import { space, useColors } from "@/theme";

function HeaderButton({
  label,
  onPress,
  children,
  testID,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
      style={styles.button}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

/** Search, notifications and settings, in every tab's header. */
export function HeaderActions() {
  const colors = useColors();
  const { data: home } = useHome();
  const unread = home?.unreadNotifications ?? 0;
  return (
    <View style={styles.row}>
      <HeaderButton label="Search" onPress={() => router.push("/search")} testID="open-search">
        <Search size={21} color={colors.foreground} />
      </HeaderButton>
      <HeaderButton
        label={unread ? `${unread} unread notifications` : "Notifications"}
        onPress={() => router.push("/notifications")}
        testID="open-notifications"
      >
        <View>
          <Bell size={21} color={colors.foreground} />
          {unread > 0 && (
            <View
              style={[styles.dot, { backgroundColor: colors.live, borderColor: colors.surface }]}
            />
          )}
        </View>
      </HeaderButton>
      <HeaderButton
        label="Settings"
        onPress={() => router.push("/settings")}
        testID="open-settings"
      >
        <Settings size={21} color={colors.foreground} />
      </HeaderButton>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginRight: space(2) },
  button: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  dot: {
    position: "absolute",
    top: -1,
    right: -1,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 2,
  },
});
