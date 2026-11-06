import { CircleAlert, Eye, EyeOff, KeyRound } from "lucide-react-native";
import { useRef, useState, type ComponentRef, type ReactNode, type Ref } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppMark } from "@/components/app-mark";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { authClient } from "@/lib/auth";
import { APP_URL } from "@/lib/config";
import { haptics } from "@/lib/haptics";
import { signInWithPasskey } from "@/lib/passkey";
import { queryClient } from "@/lib/query";
import { fonts, radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

type Input = ComponentRef<typeof TextInput>;

function Field({
  label,
  ref,
  trailing,
  ...props
}: TextInputProps & { label: string; ref?: Ref<Input>; trailing?: ReactNode }) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="small" style={{ fontWeight: "500" }}>
        {label}
      </Text>
      <View
        style={[
          styles.field,
          {
            borderColor: focused ? colors.foreground : colors.input,
            backgroundColor: colors.surface,
          },
        ]}
      >
        <TextInput
          ref={ref}
          {...props}
          accessibilityLabel={label}
          onFocus={(event) => {
            setFocused(true);
            props.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            props.onBlur?.(event);
          }}
          placeholderTextColor={colors.mutedForeground}
          cursorColor={colors.foreground}
          selectionColor={colors.input}
          style={[styles.input, { color: colors.foreground }]}
        />
        {trailing}
      </View>
    </View>
  );
}

/** Sign in with your open-bot account's email and password, or a passkey. */
export default function SignIn() {
  const colors = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const passwordField = useRef<Input>(null);

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

  async function signInWithAPasskey() {
    setPending("passkey");
    setError(null);
    const result = await signInWithPasskey();
    if (result.ok) queryClient.clear();
    // No message: you cancelled it, which needs no telling.
    else if (result.message) fail(result.message);
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
              <Text muted>Sign in to see what your teammates have been up to.</Text>
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
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              testID="password"
              trailing={
                <Pressable
                  onPress={() => setShowPassword((shown) => !shown)}
                  style={styles.reveal}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff size={18} color={colors.mutedForeground} />
                  ) : (
                    <Eye size={18} color={colors.mutedForeground} />
                  )}
                </Pressable>
              }
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
              <View style={[styles.rule, { backgroundColor: colors.border }]} />
              <Text variant="caption" muted>
                or
              </Text>
              <View style={[styles.rule, { backgroundColor: colors.border }]} />
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
  field: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    borderWidth: 1,
    borderRadius: radius.xl,
  },
  input: {
    flex: 1,
    minHeight: 50,
    paddingHorizontal: space(4),
    fontFamily: fonts.sans,
    fontSize: 16,
  },
  reveal: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
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
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
});
