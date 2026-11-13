import { router } from "expo-router";
import { Bell, Search, UserRound } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { useHome } from "@/features/home/hooks";
import { fonts, space, useColors } from "@/theme";

export function HeaderButton({
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
      android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
      style={styles.button}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

/** Your initials in a circle: where your account and the app's settings are. */
function ProfileButton() {
  const colors = useColors();
  const { data: home } = useHome();
  const name = home?.user.name.trim() ?? "";
  const letter = name ? name[0]!.toUpperCase() : "";
  return (
    <HeaderButton label="Settings" onPress={() => router.push("/settings")} testID="open-settings">
      {/* Until your name loads, a quiet person mark instead of an empty disc. */}
      <View style={[styles.profile, { backgroundColor: letter ? colors.primary : colors.subtle }]}>
        {letter ? (
          <Text
            allowFontScaling={false}
            style={{
              color: colors.primaryForeground,
              fontFamily: fonts.heading,
              fontWeight: "600",
              fontSize: 14,
              lineHeight: 18,
            }}
          >
            {letter}
          </Text>
        ) : (
          <UserRound size={18} color={colors.mutedForeground} />
        )}
      </View>
    </HeaderButton>
  );
}

/**
 * Search and notifications in every tab's header; Home also has your settings, and a tab can put
 * its own action first (`leading`).
 */
export function HeaderActions({
  profile = false,
  leading,
}: {
  profile?: boolean;
  leading?: ReactNode;
}) {
  const colors = useColors();
  const { data: home } = useHome();
  const unread = home?.unreadNotifications ?? 0;
  return (
    <View style={styles.row}>
      {leading}
      <HeaderButton label="Search" onPress={() => router.push("/search")} testID="open-search">
        <Search size={22} color={colors.foreground} />
      </HeaderButton>
      <HeaderButton
        label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        onPress={() => router.push("/notifications")}
        testID="open-notifications"
      >
        <View>
          <Bell size={22} color={colors.foreground} />
          {unread > 0 && (
            <View
              style={[
                styles.dot,
                { backgroundColor: colors.foreground, borderColor: colors.surface },
              ]}
            />
          )}
        </View>
      </HeaderButton>
      {profile && <ProfileButton />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginRight: space(2) },
  button: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  profile: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
});
