import { useState } from "react";
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { authClient } from "@/lib/auth";
import { APP_URL } from "@/lib/config";
import { queryClient } from "@/lib/query";
import { fonts, radius, space, useColors } from "@/theme";

function Field({ label, ...props }: TextInputProps & { label: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="small" style={{ fontWeight: "500" }}>
        {label}
      </Text>
      <TextInput
        {...props}
        placeholderTextColor={colors.mutedForeground}
        cursorColor={colors.foreground}
        style={[
          styles.input,
          { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.surface },
        ]}
      />
    </View>
  );
}

/** Sign in with your open-bot account's email and password. */
export default function SignIn() {
  const colors = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(result.error.message ?? "That didn't work. Check your email and password.");
        return;
      }
      queryClient.clear();
    } catch {
      setError("Couldn't reach open-bot. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={{ gap: space(2) }}>
            <Text variant="title" style={{ fontSize: 26, lineHeight: 32 }}>
              Welcome back
            </Text>
            <Text muted>Your teammates kept working while you were away.</Text>
          </View>
          <View style={{ gap: space(4) }}>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="next"
              testID="email"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              testID="password"
            />
            {error && (
              <Text
                variant="small"
                accessibilityRole="alert"
                style={[
                  styles.error,
                  { color: colors.destructive, backgroundColor: colors.subtle },
                ]}
              >
                {error}
              </Text>
            )}
            <Button
              title="Sign in"
              busy={pending}
              disabled={!email.trim() || !password}
              onPress={() => void submit()}
              style={{ minHeight: 48 }}
              testID="sign-in"
            />
          </View>
          <Text variant="caption" muted style={{ textAlign: "center" }}>
            {new URL(APP_URL).host}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: "center", padding: space(6), gap: space(8) },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(3.5),
    fontFamily: fonts.sans,
    fontSize: 15,
  },
  error: { borderRadius: radius.md, paddingHorizontal: space(3), paddingVertical: space(2) },
});
