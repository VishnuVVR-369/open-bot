import { RECOVERY_COPY, resetPasswordCommand } from "@open-bot/domain";
import { CircleAlert, KeyRound } from "lucide-react-native";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInputInstance,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppMark } from "@/components/app-mark";
import { Button } from "@/components/button";
import { CopyCommand } from "@/features/computer/components/copy-command";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { authClient } from "@/lib/auth";
import { APP_URL } from "@/lib/config";
import { haptics } from "@/lib/haptics";
import { signInWithPasskey } from "@/lib/passkey";
import { requestPasswordReset, takePasswordResetRequest } from "@/lib/password";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** A labelled field in the app's one style, with a link beside the label when there's one. */
function Field({
  label,
  labelAside,
  ...props
}: ComponentProps<typeof TextField> & {
  label: string;
  /** Beside the label, at the end: a link like "Forgot password?". */
  labelAside?: ReactNode;
}) {
  return (
    <View style={{ gap: space(2) }}>
      <View style={styles.labelRow}>
        <Text variant="small" style={{ fontWeight: "500" }}>
          {label}
        </Text>
        {labelAside}
      </View>
      <TextField {...props} accessibilityLabel={label} />
    </View>
  );
}

/**
 * What to do without your password, in the web's words (`RECOVERY_COPY`), shortest way first: a
 * passkey gets you in and opens the new-password form in Settings. Without one, the reset
 * command on the server sets it (open-bot sends no email, so there's no reset link).
 */
function ForgotPassword({
  open,
  email,
  onClose,
  onPasskey,
}: {
  open: boolean;
  email: string;
  onClose: () => void;
  onPasskey: () => void;
}) {
  const colors = useColors();
  return (
    <Sheet open={open} onClose={onClose} title={RECOVERY_COPY.title} testID="forgot-sheet">
      <View style={styles.forgot}>
        <View style={{ gap: space(3) }}>
          <Text style={styles.lead}>{RECOVERY_COPY.passkeyHeading}</Text>
          <Button
            title={RECOVERY_COPY.passkeyAction}
            icon={<KeyRound size={18} color={colors.primaryForeground} />}
            onPress={onPasskey}
            style={styles.cta}
            testID="forgot-passkey"
          />
          <Text variant="small" muted style={styles.wayBody}>
            {RECOVERY_COPY.passkeyNote}
          </Text>
        </View>
        <View style={[styles.other, { borderTopColor: colors.rule }]}>
          <Text variant="small" muted style={{ fontWeight: "600" }}>
            {RECOVERY_COPY.otherWaysHeading}
          </Text>
          <Text variant="small" muted style={styles.wayBody}>
            {RECOVERY_COPY.serverBody}
          </Text>
          <CopyCommand command={resetPasswordCommand(email)} testID="reset-command" />
          <Text variant="caption" muted>
            {RECOVERY_COPY.noEmailNote}
          </Text>
        </View>
      </View>
    </Sheet>
  );
}

/** Sign in with your open-bot account's email and password, or a passkey. */
export default function SignIn() {
  const colors = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const passwordField = useRef<TextInputInstance>(null);

  function fail(message: string) {
    haptics.error();
    setError(message);
  }

  async function submit() {
    if (!email.trim() || !password || pending) return;
    setPending("password");
    setError(null);
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        fail(result.error.message ?? "That didn't work. Check your email and password.");
        return;
      }
      queryClient.clear();
    } catch {
      fail("Couldn't reach open-bot. Check your connection.");
    } finally {
      setPending(null);
    }
  }

  /** `reset`: from "Forgot password?", so Settings opens the new-password form once you're in. */
  async function signInWithAPasskey(reset = false) {
    setPending("passkey");
    setError(null);
    if (reset) requestPasswordReset();
    const result = await signInWithPasskey();
    if (result.ok) queryClient.clear();
    else {
      takePasswordResetRequest();
      // No message: you cancelled it, which needs no telling.
      if (result.message) fail(result.message);
    }
    setPending(null);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.head}>
            <AppMark size={64} />
            <View style={{ gap: space(2) }}>
              <Text variant="title" style={styles.title} accessibilityRole="header">
                Welcome back
              </Text>
              {/* The web's words; balanced lines so the last one never holds a single word. */}
              <Text muted textBreakStrategy="balanced" style={{ fontSize: 16, lineHeight: 22 }}>
                Your teammates kept working while you were away.
              </Text>
            </View>
          </View>

          <View style={{ gap: space(4) }}>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => passwordField.current?.focus()}
              testID="email"
            />
            <Field
              ref={passwordField}
              label="Password"
              labelAside={
                <Pressable
                  onPress={() => setForgot(true)}
                  accessibilityRole="button"
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  testID="forgot-password"
                >
                  <Text variant="small" muted style={{ fontWeight: "500" }}>
                    Forgot password?
                  </Text>
                </Pressable>
              }
              value={password}
              onChangeText={setPassword}
              password
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              testID="password"
            />
            {error && (
              <View
                style={[
                  styles.error,
                  {
                    backgroundColor: mix(colors.destructive, colors.surface, 0.08),
                    borderColor: mix(colors.destructive, colors.surface, 0.3),
                  },
                ]}
                accessibilityRole="alert"
              >
                <CircleAlert size={16} color={colors.destructive} style={{ marginTop: 1 }} />
                <Text variant="small" style={{ flex: 1, color: colors.foreground }}>
                  {error}
                </Text>
              </View>
            )}
            <Button
              title="Sign in"
              busy={pending === "password"}
              disabled={!email.trim() || !password || pending !== null}
              onPress={() => void submit()}
              style={styles.cta}
              testID="sign-in"
            />
            <View style={styles.or}>
              <View style={[styles.rule, { backgroundColor: colors.rule }]} />
              <Text variant="caption" muted>
                or
              </Text>
              <View style={[styles.rule, { backgroundColor: colors.rule }]} />
            </View>
            <Button
              title="Sign in with a passkey"
              variant="outline"
              icon={<KeyRound size={18} color={colors.foreground} />}
              busy={pending === "passkey"}
              disabled={pending !== null}
              onPress={() => void signInWithAPasskey()}
              style={styles.cta}
              testID="passkey-sign-in"
            />
          </View>

          {/* Which server a development build talks to; everyone else has just the one. */}
          {__DEV__ ? (
            <Text variant="caption" muted style={{ textAlign: "center" }}>
              Server: {new URL(APP_URL).host}
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <ForgotPassword
        open={forgot}
        email={email}
        onClose={() => setForgot(false)}
        onPasskey={() => {
          setForgot(false);
          void signInWithAPasskey(true);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: space(6),
    paddingVertical: space(8),
    gap: space(10),
  },
  head: { gap: space(6) },
  title: { fontSize: 30, lineHeight: 36 },
  error: {
    flexDirection: "row",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
  cta: { minHeight: 52 },
  or: { flexDirection: "row", alignItems: "center", gap: space(3) },
  rule: { flex: 1, height: 1 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  forgot: { gap: space(6), paddingHorizontal: space(5), paddingTop: space(1) },
  lead: { fontSize: 16, lineHeight: 22, fontWeight: "500" },
  wayBody: { fontSize: 14, lineHeight: 20 },
  // Quieter, under a rule: for when there's no passkey.
  other: { gap: space(2.5), borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space(5) },
});
