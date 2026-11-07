import { newPasswordProblem, PASSWORD_MIN_LENGTH, passwordChangeProblem } from "@open-bot/shared";
import { KeyRound } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, View, type TextInputInstance } from "react-native";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { haptics } from "@/lib/haptics";
import { signInWithPasskey } from "@/lib/passkey";
import { canSetWithoutCurrent, changePassword, setPasswordAfterPasskey } from "@/lib/password";
import { space, useColors } from "@/theme";

type Mode = "change" | "reset";

/**
 * Change the sign-in password, as on the web: with the current one, or, when that's forgotten,
 * after confirming with a passkey (right after a passkey sign-in it isn't asked for again).
 * Either way every other device is signed out and this phone stays in.
 */
export function PasswordSheet({
  open,
  onClose,
  viaPasskey,
}: {
  open: boolean;
  onClose: () => void;
  /** Settings' "Reset with a passkey": ask for the passkey straight away. */
  viaPasskey?: boolean;
}) {
  const colors = useColors();
  const [mode, setMode] = useState<Mode>("change");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "passkey" | null>(null);
  const first = useRef<TextInputInstance>(null);

  useEffect(() => {
    if (!open) return;
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setMode("change");
    let live = true;
    // Just signed in with a passkey: no need for the old password.
    void canSetWithoutCurrent().then((ready) => {
      if (!live) return;
      if (ready) setMode("reset");
      else if (viaPasskey) void confirmWithPasskey();
    });
    return () => {
      live = false;
    };
  }, [open, viaPasskey]);

  async function confirmWithPasskey() {
    setPending("passkey");
    setError(null);
    const result = await signInWithPasskey();
    const ready = result.ok && (await canSetWithoutCurrent());
    setPending(null);
    if (ready) {
      setMode("reset");
      setCurrent("");
      return;
    }
    if (result.ok) setError("Your passkey didn't confirm it's you. Use your fingerprint or PIN.");
    else if (result.message) setError(result.message);
  }

  async function save() {
    const problem =
      mode === "reset"
        ? newPasswordProblem({ next, confirm })
        : passwordChangeProblem({ current, next, confirm });
    if (problem) {
      haptics.error();
      setError(problem);
      return;
    }
    setPending("save");
    setError(null);
    const result =
      mode === "reset" ? await setPasswordAfterPasskey(next) : await changePassword(current, next);
    setPending(null);
    if (!result.ok) {
      haptics.error();
      setError(result.message);
      return;
    }
    haptics.success();
    onClose();
    Alert.alert(
      mode === "reset" ? "New password set" : "Password changed",
      "Your other devices were signed out. This phone stays signed in.",
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={mode === "reset" ? "Set a new password" : "Change password"}
      description={
        mode === "reset"
          ? "You confirmed with your passkey, so the old password isn't needed."
          : "Signs out your other devices."
      }
      focusOnShow={first}
      testID="password-sheet"
    >
      <View style={styles.form}>
        {mode === "change" && (
          <View style={styles.field}>
            <Text variant="small" style={{ fontWeight: "500" }}>
              Current password
            </Text>
            <TextField
              ref={first}
              value={current}
              onChangeText={setCurrent}
              password
              autoComplete="current-password"
              testID="password-current"
            />
            {/* Its own row, under the field it stands in for. */}
            <Pressable
              onPress={() => void confirmWithPasskey()}
              disabled={pending !== null}
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              style={styles.forgot}
              testID="password-use-passkey"
            >
              <KeyRound size={14} color={colors.mutedForeground} />
              <Text variant="small" muted style={{ fontWeight: "500" }}>
                {pending === "passkey" ? "Checking…" : "Forgot it? Use your passkey"}
              </Text>
            </Pressable>
          </View>
        )}
        <View style={styles.field}>
          <Text variant="small" style={{ fontWeight: "500" }}>
            New password
          </Text>
          <TextField
            ref={mode === "reset" ? first : undefined}
            value={next}
            onChangeText={setNext}
            password
            autoComplete="new-password"
            testID="password-new"
          />
          <Text variant="caption" muted>
            At least {PASSWORD_MIN_LENGTH} characters.
          </Text>
        </View>
        <View style={styles.field}>
          <Text variant="small" style={{ fontWeight: "500" }}>
            Confirm new password
          </Text>
          <TextField
            value={confirm}
            onChangeText={setConfirm}
            password
            autoComplete="new-password"
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            testID="password-confirm"
          />
        </View>
        {error && (
          <Text variant="small" style={{ color: colors.destructive }} accessibilityRole="alert">
            {error}
          </Text>
        )}
        <Button
          title={mode === "reset" ? "Set new password" : "Change password"}
          busy={pending === "save"}
          disabled={pending !== null || !next || !confirm || (mode === "change" && !current)}
          onPress={() => void save()}
          testID="password-save"
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  form: { paddingHorizontal: space(5), paddingTop: space(1), gap: space(4) },
  field: { gap: space(2) },
  forgot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space(1.5),
    minHeight: 32,
  },
});
