import { Tabs } from "expo-router";
import { House, MessagesSquare, Monitor, ShieldCheck } from "lucide-react-native";
import { HeaderActions } from "@/components/header-actions";
import { useApprovals, useChats } from "@/lib/queries";
import { fonts, useColors } from "@/theme";

export default function TabsLayout() {
  const colors = useColors();
  const { data: approvals } = useApprovals();
  const { data: chats } = useChats();
  const pending = approvals?.filter((approval) => approval.status === "pending").length ?? 0;
  const unread = chats?.filter((chat) => chat.unread).length ?? 0;
  const badgeStyle = {
    color: "#FFFFFF",
    fontFamily: fonts.sans,
    fontSize: 11,
  };
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
        headerRight: () => <HeaderActions />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <House color={color} size={size - 2} />,
          tabBarButtonTestID: "tab-home",
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: "Chats",
          tabBarIcon: ({ color, size }) => <MessagesSquare color={color} size={size - 2} />,
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { ...badgeStyle, backgroundColor: colors.live },
          tabBarButtonTestID: "tab-chats",
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: "Approvals",
          tabBarIcon: ({ color, size }) => <ShieldCheck color={color} size={size - 2} />,
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { ...badgeStyle, backgroundColor: colors.waiting },
          tabBarButtonTestID: "tab-approvals",
        }}
      />
      <Tabs.Screen
        name="computer"
        options={{
          title: "Computer",
          tabBarIcon: ({ color, size }) => <Monitor color={color} size={size - 2} />,
          tabBarButtonTestID: "tab-computer",
        }}
      />
    </Tabs>
  );
}
