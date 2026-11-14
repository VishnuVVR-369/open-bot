import { Tabs } from "expo-router";
import { FileText, House, MessagesSquare, Monitor, ShieldCheck } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { AppMark } from "@/components/app-mark";
import { HeaderActions } from "@/features/home/components/header-actions";
import { haptics } from "@/lib/haptics";
import { useApprovals } from "@/features/approvals/hooks";
import { useChats } from "@/features/chat/hooks";
import { fonts, space, useColors } from "@/theme";

export default function TabsLayout() {
  const colors = useColors();
  const { data: approvals } = useApprovals();
  const { data: chats } = useChats();
  const pending = approvals?.filter((approval) => approval.status === "pending").length ?? 0;
  const unread = chats?.filter((chat) => chat.unread).length ?? 0;
  const badgeStyle = {
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: "600" as const,
  };
  return (
    <Tabs
      screenListeners={{ tabPress: () => haptics.tap() }}
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTitleStyle: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 22 },
        headerTintColor: colors.foreground,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.background },
        // A hairline above the bar, so rows scrolling under it end on a line, not a hard cut.
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth * 2,
          elevation: 0,
        },
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
          // The greeting is the page's title; the bar holds the app's mark and the actions.
          headerTitle: "",
          headerLeft: () => (
            <View style={{ marginLeft: space(4) }}>
              <AppMark size={30} />
            </View>
          ),
          headerRight: () => <HeaderActions profile />,
          tabBarIcon: ({ color, size, focused }) => (
            <House color={color} size={size - 2} strokeWidth={focused ? 2.4 : 2} />
          ),
          tabBarButtonTestID: "tab-home",
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: "Chats",
          tabBarIcon: ({ color, size, focused }) => (
            <MessagesSquare color={color} size={size - 2} strokeWidth={focused ? 2.4 : 2} />
          ),
          tabBarBadge: unread > 0 ? unread : undefined,
          // Unread is news, not a request: a neutral count. Amber is only for what needs you.
          tabBarBadgeStyle: {
            ...badgeStyle,
            color: colors.surface,
            backgroundColor: colors.mutedForeground,
          },
          tabBarAccessibilityLabel: unread > 0 ? `Chats, ${unread} unread` : "Chats",
          tabBarButtonTestID: "tab-chats",
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: "Approvals",
          tabBarIcon: ({ color, size, focused }) => (
            <ShieldCheck color={color} size={size - 2} strokeWidth={focused ? 2.4 : 2} />
          ),
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { ...badgeStyle, color: "#1A1200", backgroundColor: colors.attention },
          tabBarAccessibilityLabel:
            pending > 0 ? `Approvals, ${pending} need your approval` : "Approvals",
          tabBarButtonTestID: "tab-approvals",
        }}
      />
      <Tabs.Screen
        name="pages"
        options={{
          title: "Pages",
          tabBarIcon: ({ color, size, focused }) => (
            <FileText color={color} size={size - 2} strokeWidth={focused ? 2.4 : 2} />
          ),
          tabBarButtonTestID: "tab-pages",
        }}
      />
      <Tabs.Screen
        name="computer"
        options={{
          title: "Computer",
          tabBarIcon: ({ color, size, focused }) => (
            <Monitor color={color} size={size - 2} strokeWidth={focused ? 2.4 : 2} />
          ),
          tabBarButtonTestID: "tab-computer",
        }}
      />
    </Tabs>
  );
}
