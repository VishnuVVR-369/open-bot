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
import { authClient } from "@/lib/auth";
import { useAppLock } from "@/lib/lock";
import { queryClient, setUnauthorizedHandler } from "@/lib/query";
import { RealtimeProvider } from "@/lib/realtime";
import { signOut } from "@/lib/session";
import { usePushNotifications } from "@/push/register";
import { fonts, useColors } from "@/theme";

void SplashScreen.preventAutoHideAsync();

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
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTitleStyle: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 18 },
            headerTintColor: colors.foreground,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="chats/[chatId]" options={{ title: "" }} />
            <Stack.Screen name="approvals/[approvalId]" options={{ title: "Approval" }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
        {signedIn && lock.locked && <LockScreen onUnlock={() => void lock.unlock()} />}
      </RealtimeProvider>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </ThemeProvider>
  );
}
