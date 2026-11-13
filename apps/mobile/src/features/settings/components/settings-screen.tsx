import { RECOVERY_COPY } from "@open-bot/domain";
import { safe } from "@orpc/client";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { router, useLocalSearchParams } from "expo-router";
import {
  BellOff,
  BellRing,
  ChevronRight,
  Fingerprint,
  Globe,
  Info,
  KeyRound,
  LockKeyhole,
  LogOut,
  Moon,
  RotateCcwKey,
  Smartphone,
  ShieldCheck,
  Sun,
  Vibrate,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Separator } from "@/components/list-row";
import { PasswordSheet } from "@/features/settings/components/password-sheet";
import { Card, Section } from "@/components/section";
import {
  Segmented,
  SETTINGS_INSET,
  SettingsRow,
  SettingsSwitch,
} from "@/features/settings/components/settings-row";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { APP_URL } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { addPasskey } from "@/lib/passkey";
import { setPreference, usePreferences, type Preferences } from "@/lib/preferences";
import { useApprovalRules } from "@/features/approvals/hooks";
import { signOut } from "@/lib/session";
import { hasFirebase } from "@/push/firebase";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { fonts, radius, space, useColors } from "@/theme";

const APPEARANCES: {
  value: Preferences["appearance"];
  label: string;
  icon: (color: string) => React.ReactNode;
}[] = [
  { value: "system", label: "System", icon: (color) => <Smartphone size={16} color={color} /> },
  { value: "light", label: "Light", icon: (color) => <Sun size={16} color={color} /> },
  { value: "dark", label: "Dark", icon: (color) => <Moon size={16} color={color} /> },
];

/** Whether the app lock can work here: it needs a screen lock or fingerprint on the phone. */
function useCanLock(): boolean | null {
  const [canLock, setCanLock] = useState<boolean | null>(null);
  useEffect(() => {
    void LocalAuthentication.getEnrolledLevelAsync()
      .then((level) => setCanLock(level !== LocalAuthentication.SecurityLevel.NONE))
      .catch(() => setCanLock(null));
  }, []);
  return canLock;
}

/** Your account on this phone, and how the app looks, feels and keeps itself safe. */
export default function Settings() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const { data: session } = authClient.useSession();
  const preferences = usePreferences();
  const { data: rules } = useApprovalRules();
  const canLock = useCanLock();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [passkeyResult, setPasskeyResult] = useState<string | null>(null);
  // "?password=new": you just signed in with a passkey from "Forgot password?".
  const { password } = useLocalSearchParams<{ password?: string }>();
  const [passwordOpen, setPasswordOpen] = useState<false | "change" | "passkey">(
    password === "new" ? "change" : false,
  );
  const name = session?.user.name?.trim() || "You";
  const host = new URL(APP_URL).host;

  async function add() {
    setAdding(true);
    setPasskeyResult(null);
    const result = await addPasskey();
    setAdding(false);
    if (result.ok) haptics.success();
    setPasskeyResult(
      result.ok ? "Passkey added. Use it the next time you sign in." : result.message,
    );
  }

  /** Turning the lock off takes your fingerprint, so a phone left open can't switch it off. */
  async function changeAppLock(value: boolean) {
    if (!value) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Turn off app lock",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });
      if (!result.success) return;
    }
    haptics.tap();
    setPreference("appLock", value);
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    const result = await safe(api.push.test());
    setTesting(false);
    setTestResult(
      result.error
        ? errorMessage(result.error)
        : result.data.sent === 0
          ? "No device is set up for notifications yet."
          : `Sent to ${result.data.sent} ${result.data.sent === 1 ? "device" : "devices"}.`,
    );
  }

  function confirmSignOut() {
    haptics.warning();
    Alert.alert("Sign out?", "This phone stops getting notifications until you sign in again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottom }]}>
        <Section title="Account">
          <Card>
            <View style={styles.account}>
              <View style={[styles.initial, { backgroundColor: colors.primary }]}>
                <Text
                  allowFontScaling={false}
                  style={[styles.initialText, { color: colors.primaryForeground }]}
                >
                  {name[0]!.toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="heading" numberOfLines={1}>
                  {name}
                </Text>
                {session?.user.email ? (
                  <Text variant="small" muted numberOfLines={1}>
                    {session.user.email}
                  </Text>
                ) : null}
              </View>
            </View>
          </Card>
        </Section>

        <Section title="Appearance">
          <Card>
            <View style={styles.theme}>
              <Text variant="label">Theme</Text>
              <Segmented
                options={APPEARANCES}
                value={preferences.appearance}
                onChange={(value) => {
                  haptics.tap();
                  setPreference("appearance", value);
                }}
                testID="appearance"
              />
            </View>
          </Card>
        </Section>

        <Section title="Feedback">
          <Card>
            <SettingsSwitch
              icon={(color) => <Vibrate size={18} color={color} />}
              title="Haptics"
              subtitle="A light touch when you tap, approve or deny"
              value={preferences.haptics}
              onChange={(value) => {
                setPreference("haptics", value);
                // Feel it right away when it's turned on.
                haptics.tap();
              }}
              testID="haptics"
            />
          </Card>
        </Section>

        <Section title="Notifications">
          <Card>
            {hasFirebase ? (
              <SettingsRow
                icon={(color) => <BellRing size={18} color={color} />}
                title="Send a test notification"
                subtitle={
                  testResult ?? "Approvals and replies come to this phone, even when it's closed"
                }
                busy={testing}
                onPress={() => void sendTest()}
                testID="test-notification"
              />
            ) : (
              <SettingsRow
                icon={(color) => <BellOff size={18} color={color} />}
                title="Phone alerts"
                subtitle="Phone alerts aren't available in this build yet. Approvals and replies show here and in the bell."
                testID="test-notification"
              />
            )}
          </Card>
        </Section>

        <Section title="Security">
          <Card>
            <SettingsSwitch
              icon={(color) => <Fingerprint size={18} color={color} />}
              title="App lock"
              subtitle={
                canLock === false
                  ? "Set up a screen lock on this phone to lock open-bot"
                  : "Asks for your fingerprint when you open open-bot, and after 5 minutes away"
              }
              value={canLock !== false && preferences.appLock}
              disabled={canLock !== true}
              onChange={(value) => void changeAppLock(value)}
              testID="app-lock"
            />
            <Separator inset={SETTINGS_INSET} />
            <SettingsRow
              icon={(color) => <LockKeyhole size={18} color={color} />}
              title="Change password"
              subtitle="Signs out your other devices"
              onPress={() => setPasswordOpen("change")}
              aside={<ChevronRight size={18} color={colors.mutedForeground} />}
              testID="change-password"
            />
            <Separator inset={SETTINGS_INSET} />
            {/* The short way back in when the password is forgotten, right beside changing it. */}
            <SettingsRow
              icon={(color) => <RotateCcwKey size={18} color={color} />}
              title={RECOVERY_COPY.resetAction}
              subtitle={RECOVERY_COPY.settingsForgot}
              onPress={() => setPasswordOpen("passkey")}
              aside={<ChevronRight size={18} color={colors.mutedForeground} />}
              testID="reset-with-passkey"
            />
            <Separator inset={SETTINGS_INSET} />
            <SettingsRow
              icon={(color) => <KeyRound size={18} color={color} />}
              title="Add a passkey"
              subtitle={
                passkeyResult ??
                "Sign in with your fingerprint instead of your password, here or on the web"
              }
              busy={adding}
              onPress={() => void add()}
              aside={<ChevronRight size={18} color={colors.mutedForeground} />}
              testID="add-passkey"
            />
            <Separator inset={SETTINGS_INSET} />
            <SettingsRow
              icon={(color) => <ShieldCheck size={18} color={color} />}
              title="Always allowed"
              subtitle={
                rules?.length
                  ? `${rules.length} ${rules.length === 1 ? "rule" : "rules"} teammates don't ask about`
                  : "What teammates may do without asking"
              }
              onPress={() => router.push("/approval-rules")}
              aside={<ChevronRight size={18} color={colors.mutedForeground} />}
              testID="settings-approval-rules"
            />
          </Card>
        </Section>

        <Section title="About">
          <Card>
            <SettingsRow
              icon={(color) => <Info size={18} color={color} />}
              title="Version"
              aside={
                <Text variant="small" muted selectable>
                  {Constants.expoConfig?.version ?? "Unknown"}
                  {__DEV__ ? " (dev)" : ""}
                </Text>
              }
            />
            <Separator inset={SETTINGS_INSET} />
            <SettingsRow
              icon={(color) => <Globe size={18} color={color} />}
              title="Server"
              aside={
                <Text variant="small" muted numberOfLines={1} selectable style={styles.value}>
                  {host}
                </Text>
              }
            />
          </Card>
        </Section>

        <Card>
          <SettingsRow
            icon={(color) => <LogOut size={18} color={color} />}
            title="Sign out"
            destructive
            onPress={confirmSignOut}
            testID="sign-out"
          />
        </Card>
      </ScrollView>
      <PasswordSheet
        open={passwordOpen !== false}
        viaPasskey={passwordOpen === "passkey"}
        onClose={() => setPasswordOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(6) },
  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    padding: space(4),
  },
  initial: {
    width: 52,
    height: 52,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  initialText: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 22, lineHeight: 28 },
  theme: { padding: space(4), gap: space(3) },
  value: { maxWidth: 180 },
});
