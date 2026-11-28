import { useNavigation } from "expo-router";
import { Fingerprint, LockKeyhole } from "lucide-react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Keyboard, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { ComputerAccess } from "@/features/computer/computer-access";
import { shouldRelock } from "@/lib/lock";
import { getPreferences } from "@/lib/preferences";
import { useNoScreenCapture } from "@/lib/screen-capture";
import { space, useColors } from "@/theme";
import { useVaultLock, useVaultScreen, vaultLock } from "../hooks";
import { NO_SCREEN_LOCK } from "../unlock";

/** Whether the vault is open on this screen: editors stop taking input while it's locked. */
export const VaultOpen = createContext(false);
export const useVaultOpen = () => useContext(VaultOpen);

/**
 * Every vault screen sits behind this. Nothing of the vault is read or shown until your
 * fingerprint (or the phone's PIN) opens it; it asks as you come in and as you come back to the
 * app, and covers the screen again when it locks, keeping what's under it. The screen also stays
 * out of screenshots, recordings and the recent apps preview.
 */
export function VaultGate({ children }: { children: ReactNode }) {
  useVaultScreen();
  useNoScreenCapture();
  const { openedAt, prompting } = useVaultLock();
  const open = openedAt !== null;
  const [shown, setShown] = useState(open);
  const [problem, setProblem] = useState<string | null>(null);
  const appUnlocked = useContext(ComputerAccess);
  const navigation = useNavigation();
  const backgroundedAt = useRef<number | null>(null);

  const ask = useCallback(async () => {
    setProblem(null);
    const result = await vaultLock.unlock();
    if (!result.ok && result.reason === "no-screen-lock") setProblem(NO_SCREEN_LOCK);
  }, []);
  // Asks on its own only where you'd expect it: coming in, and coming back. A lock after its five
  // minutes while you're here waits for the button, so it never pops up while you type.
  const askHere = useCallback(() => {
    if (vaultLock.isOpen() || !navigation.isFocused() || AppState.currentState !== "active") return;
    void ask();
  }, [ask, navigation]);

  // Coming in, and once the app's own lock (asked first) has let you in.
  useEffect(() => {
    if (appUnlocked) askHere();
  }, [appUnlocked, askHere]);
  useEffect(() => navigation.addListener("focus", askHere), [navigation, askHere]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") backgroundedAt.current = Date.now();
      if (state !== "active") return;
      // Away long enough for the app lock: it asks first, and the effect above follows it.
      const appLocks = getPreferences().appLock && shouldRelock(backgroundedAt.current, Date.now());
      backgroundedAt.current = null;
      if (!appLocks) askHere();
    });
    return () => subscription.remove();
  }, [askHere]);

  useEffect(() => {
    if (open) {
      setShown(true);
      setProblem(null);
    } else Keyboard.dismiss();
  }, [open]);

  return (
    <VaultOpen.Provider value={open}>
      <View style={{ flex: 1 }}>
        {shown && children}
        {!open && <VaultLocked problem={problem} busy={prompting} onOpen={() => void ask()} />}
      </View>
    </VaultOpen.Provider>
  );
}

function VaultLocked({
  problem,
  busy,
  onOpen,
}: {
  problem: string | null;
  busy: boolean;
  onOpen: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        styles.screen,
        { backgroundColor: colors.background, paddingBottom: insets.bottom + space(6) },
      ]}
      testID="vault-locked"
    >
      <View style={styles.middle}>
        <View style={[styles.tile, { backgroundColor: colors.subtle }]}>
          <LockKeyhole size={28} color={colors.foreground} />
        </View>
        <View style={styles.words}>
          <Text variant="title" style={styles.center} accessibilityRole="header">
            The vault is locked
          </Text>
          <Text muted style={[styles.center, styles.body]} testID="vault-locked-body">
            {problem ?? "Use your fingerprint or screen lock to see logins, cards and budgets."}
          </Text>
        </View>
      </View>
      <Button
        title="Open the vault"
        icon={<Fingerprint size={20} color={colors.primaryForeground} />}
        onPress={onOpen}
        busy={busy}
        style={styles.button}
        testID="vault-unlock"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: space(6) },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", gap: space(5) },
  tile: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  words: { alignItems: "center", gap: space(2) },
  center: { textAlign: "center" },
  body: { maxWidth: 300 },
  button: { alignSelf: "stretch", minHeight: 52 },
});
