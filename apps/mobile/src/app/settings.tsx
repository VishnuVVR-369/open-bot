import { safe } from "@orpc/client";
import Constants from "expo-constants";
import { BellRing, LogOut } from "lucide-react-native";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { APP_URL } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { signOut } from "@/lib/session";
import { hasFirebase } from "@/push/firebase";
import { radius, space, useColors } from "@/theme";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="caption" muted style={styles.overline}>
        {title.toUpperCase()}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {children}
      </View>
    </View>
  );
}

/** Your account on this phone: notifications, and signing out. */
export default function Settings() {
  const colors = useColors();
  const { data: session } = authClient.useSession();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

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
    Alert.alert("Sign out?", "This phone stops getting notifications until you sign in again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Section title="Account">
        <View style={{ gap: 2 }}>
          <Text variant="label">{session?.user.name ?? "You"}</Text>
          <Text variant="small" muted>
            {session?.user.email}
          </Text>
          <Text variant="small" muted>
            {new URL(APP_URL).host}
          </Text>
        </View>
      </Section>
      <Section title="Notifications">
        <Text variant="small" muted>
          {hasFirebase
            ? "Approvals and replies come to this phone, even when the app is closed."
            : "This build can't get notifications: it was built without Firebase."}
        </Text>
        <Button
          title="Send a test notification"
          variant="outline"
          icon={<BellRing size={16} color={colors.foreground} />}
          busy={testing}
          onPress={() => void sendTest()}
        />
        {testResult && (
          <Text variant="small" muted>
            {testResult}
          </Text>
        )}
      </Section>
      <Button
        title="Sign out"
        variant="destructive"
        icon={<LogOut size={16} color={colors.destructive} />}
        onPress={confirmSignOut}
        testID="sign-out"
      />
      <Text variant="caption" muted style={{ textAlign: "center" }}>
        open-bot {Constants.expoConfig?.version ?? ""}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(6) },
  overline: { letterSpacing: 0.6, fontWeight: "500", paddingHorizontal: space(1) },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(2) },
});
