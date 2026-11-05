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
import { ComputerAccess } from "@/lib/computer-access";
import { authClient } from "@/lib/auth";
import { useAppLock } from "@/lib/lock";
import { loadPreferences } from "@/lib/preferences";
import { useTrackPresence } from "@/lib/presence";
import { queryClient, setUnauthorizedHandler } from "@/lib/query";
import { RealtimeProvider } from "@/lib/realtime";
import { signOut } from "@/lib/session";
import { useIncomingShares } from "@/lib/share-inbox";
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
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session);
  const lock = useAppLock(isPending ? "pending" : signedIn ? "signedIn" : "signedOut");
  usePushNotifications(signedIn);
  useTrackPresence(signedIn);
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
              <Stack.Screen name="teammates/[botId]" options={{ title: "" }} />
              <Stack.Screen name="approvals/[approvalId]" options={{ title: "Approval" }} />
              <Stack.Screen name="screens/[screenId]" options={{ title: "Computer" }} />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen name="new-chat" options={{ title: "New chat" }} />
              <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
              <Stack.Screen name="search" options={{ title: "Search", animation: "fade" }} />
              <Stack.Screen name="file" options={{ title: "" }} />
              <Stack.Screen name="approval-rules" options={{ title: "Always allowed" }} />
              <Stack.Screen name="pages/index" options={{ title: "Pages" }} />
              <Stack.Screen name="pages/[pageId]" options={{ title: "" }} />
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
