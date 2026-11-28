import { QueryClientProvider } from "@tanstack/react-query";
import {
  DarkTheme,
  DefaultTheme,
  SplashScreen,
  Stack,
  ThemeProvider,
  type Theme,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo } from "react";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LockScreen } from "@/components/lock-screen";
import { ComputerAccess } from "@/features/computer/computer-access";
import { authClient } from "@/lib/auth";
import { useAppLock } from "@/lib/lock";
import { usePendingRevokes } from "@/lib/phone-egress";
import { loadPreferences } from "@/lib/preferences";
import { useTrackPresence } from "@/lib/presence";
import { queryClient, setUnauthorizedHandler } from "@/lib/query";
import { RealtimeProvider } from "@/lib/realtime";
import { signOut, useSignOutWhenSessionEnds } from "@/lib/session";
import { useIncomingShares } from "@/features/chat/share-inbox";
import { usePushNotifications } from "@/push/register";
import { fonts, useColors } from "@/theme";

void SplashScreen.preventAutoHideAsync();
// The saved theme applies before the splash screen hides, so the app never flashes the other one.
void loadPreferences();

// A screen opened straight from a link or a notification still has the tabs behind it to go back to.
export const unstable_settings = { anchor: "(tabs)" };

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function App() {
  const colors = useColors();
  const scheme = useColorScheme();
  const { data: session, isPending, error } = authClient.useSession();
  const signedIn = Boolean(session);
  const lock = useAppLock(isPending ? "pending" : signedIn ? "signedIn" : "signedOut");
  usePushNotifications(session?.session.id ?? null);
  useSignOutWhenSessionEnds({ data: session, isPending, error });
  useTrackPresence(signedIn);
  // A phone connection that an offline sign-out couldn't revoke is revoked once back.
  usePendingRevokes(signedIn);
  // Something shared from another app opens once you're signed in and past the lock.
  useIncomingShares(signedIn && !lock.locked && !lock.checking);

  // Signed out elsewhere, or the session expired: back to sign-in, with nothing left behind.
  useEffect(() => setUnauthorizedHandler(() => void signOut()), []);
  useEffect(() => {
    if (!isPending && !lock.checking) void SplashScreen.hideAsync();
  }, [isPending, lock.checking]);

  const theme = useMemo<Theme>(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.foreground,
        background: colors.background,
        card: colors.surface,
        text: colors.foreground,
        border: colors.border,
        notification: colors.live,
      },
    };
  }, [scheme, colors]);

  // Keep the navigator mounted while auth refreshes after sign-out or a passkey prompt.
  // The splash screen already covers the initial session and lock checks.
  return (
    <ThemeProvider value={theme}>
      <RealtimeProvider enabled={signedIn} onSignedOut={() => void signOut()}>
        <ComputerAccess.Provider value={!lock.locked && !lock.checking}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.background },
              headerTitleStyle: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 18 },
              headerTintColor: colors.foreground,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="chats/[chatId]" options={{ title: "" }} />
              <Stack.Screen name="teammates/[teammateId]" options={{ title: "" }} />
              <Stack.Screen name="approvals/[approvalId]" options={{ title: "Approval" }} />
              <Stack.Screen name="screens/[screenId]" options={{ title: "Computer" }} />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen name="new-chat" options={{ title: "New chat" }} />
              <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
              <Stack.Screen name="search" options={{ title: "Search", animation: "fade" }} />
              <Stack.Screen name="file" options={{ title: "" }} />
              <Stack.Screen name="approval-rules" options={{ title: "Always allowed" }} />
              <Stack.Screen name="phone-connection" options={{ title: "Phone connection" }} />
              <Stack.Screen name="pages/[pageId]" options={{ title: "" }} />
              <Stack.Screen name="tasks/index" options={{ title: "Tasks" }} />
              <Stack.Screen name="tasks/new" options={{ title: "New task" }} />
              <Stack.Screen name="tasks/[taskId]" options={{ title: "Task" }} />
              <Stack.Screen name="automations/index" options={{ title: "Automations" }} />
              <Stack.Screen
                name="automations/[kind]/[automationId]/index"
                options={{ title: "" }}
              />
              <Stack.Screen
                name="automations/[kind]/[automationId]/edit"
                options={{ title: "Edit" }}
              />
              <Stack.Screen name="memory/index" options={{ title: "Memory" }} />
              <Stack.Screen name="memory/new" options={{ title: "New memory" }} />
              <Stack.Screen name="memory/lessons" options={{ title: "Lessons" }} />
              <Stack.Screen name="memory/[memoryId]/index" options={{ title: "Memory" }} />
              <Stack.Screen name="memory/[memoryId]/history" options={{ title: "History" }} />
              <Stack.Screen name="share" options={{ title: "Share with a teammate" }} />
            </Stack.Protected>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
        </ComputerAccess.Provider>
        {signedIn && lock.locked && <LockScreen onUnlock={() => void lock.unlock()} />}
      </RealtimeProvider>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </ThemeProvider>
  );
}
