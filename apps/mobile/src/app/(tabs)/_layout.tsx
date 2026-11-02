import { router, Tabs } from "expo-router";
import { MessagesSquare, Settings, ShieldCheck, Users } from "lucide-react-native";
import { Pressable } from "react-native";
import { useApprovals } from "@/lib/queries";
import { fonts, space, useColors } from "@/theme";

export default function TabsLayout() {
  const colors = useColors();
  const { data: approvals } = useApprovals();
  const pending = approvals?.filter((approval) => approval.status === "pending").length ?? 0;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 20 },
        headerTintColor: colors.foreground,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.foreground,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarLabelStyle: { fontFamily: fonts.sans, fontSize: 12, fontWeight: "500" },
        headerRight: () => (
          <Pressable
            onPress={() => router.push("/settings")}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            hitSlop={8}
            style={{ marginRight: space(4) }}
          >
            <Settings size={22} color={colors.foreground} />
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Teammates",
          tabBarIcon: ({ color, size }) => <Users color={color} size={size - 2} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: "Chats",
          tabBarIcon: ({ color, size }) => <MessagesSquare color={color} size={size - 2} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: "Approvals",
          tabBarIcon: ({ color, size }) => <ShieldCheck color={color} size={size - 2} />,
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.waiting,
            color: "#FFFFFF",
            fontFamily: fonts.sans,
            fontSize: 11,
          },
        }}
      />
    </Tabs>
  );
}
