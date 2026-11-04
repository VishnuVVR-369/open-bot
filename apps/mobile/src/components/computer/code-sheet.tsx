import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ScreenOperation } from "@open-bot/shared";
import { useContext, useEffect, useState } from "react";
import { Switch, View } from "react-native";
import * as Crypto from "expo-crypto";
import SmsConsent from "../../../modules/sms-consent";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { ComputerAccess } from "@/lib/computer-access";
import { errorMessage } from "@/lib/errors";
import { queryClient, queryKeys } from "@/lib/query";
import { recoverCodeOperation } from "@/lib/screens";
import { useColors } from "@/theme";
import { DESKTOP_ASPECT_RATIO, DesktopView } from "./desktop-view";

const terminal = new Set(["handed_back", "cancelled", "failed", "needs_owner", "unknown"]);

const refreshScreens = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.screens }),
    queryClient.invalidateQueries({ queryKey: queryKeys.home }),
  ]);

export function CodeSheet({
  screenId,
  takeoverId,
  open,
  onClose,
}: {
  screenId: string;
  takeoverId: string;
  open: boolean;
  onClose: () => void;
}) {
  const access = useContext(ComputerAccess);
  const colors = useColors();
  const [text, setText] = useState("");
  const [pressEnter, setPressEnter] = useState(true);
  const [site, setSite] = useState<string | null>(null);
  const [operation, setOperation] = useState<ScreenOperation | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewConnected, setPreviewConnected] = useState(false);
  const [error, setError] = useState("");
  const key = `screen-operation:${takeoverId}`;

  useEffect(() => {
    if (!open || !access) {
      setText("");
      return;
    }
    let disposed = false;
    setError("");
    setSite(null);
    setOperation(null);
    setUnknown(false);
    // Until the browser shows a focused field, keep checking, so focusing it there is enough.
    let siteTimer: ReturnType<typeof setTimeout> | undefined;
    const loadSite = () =>
      void api.takeovers
        .codeContext({ takeoverId })
        .then((context) => {
          if (disposed) return;
          setSite(context.site);
          if (!context.site) siteTimer = setTimeout(loadSite, 2000);
        })
        .catch((e) => {
          if (!disposed) setError(errorMessage(e));
        });
    loadSite();
    void AsyncStorage.getItem(key).then(async (id) => {
      if (!id) return;
      try {
        const result = await recoverCodeOperation(
          id,
          (operationId) => api.screenOperations.get({ operationId }),
          (operationId) => api.screenOperations.cancel({ operationId }),
        );
        if (!disposed) setOperation(result);
      } catch {
        if (!disposed) setUnknown(true);
      }
    });
    const subscription = SmsConsent.addListener("code", (event) => {
      if (!disposed && event.code) setText(event.code);
    });
    void SmsConsent.start().catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(siteTimer);
      subscription.remove();
      SmsConsent.stop();
      setText("");
    };
  }, [open, access, takeoverId, key]);

  useEffect(() => {
    if (!open || !operation || terminal.has(operation.status)) return;
    const timer = setInterval(() => {
      void api.screenOperations
        .get({ operationId: operation.id })
        .then((result) => {
          if (result) setOperation(result);
          void refreshScreens();
        })
        .catch(() => setUnknown(true));
    }, 1500);
    return () => clearInterval(timer);
  }, [open, operation]);

  async function send() {
    if (!site || !previewConnected || busy || unknown) return;
    setBusy(true);
    setError("");
    const operationId = Crypto.randomUUID();
    try {
      await AsyncStorage.setItem(key, operationId);
      const value = text;
      setText("");
      SmsConsent.stop();
      try {
        setOperation(
          await api.screenOperations.type({
            takeoverId,
            operationId,
            expectedSite: site,
            pressEnter,
            text: value,
          }),
        );
      } catch {
        try {
          setOperation(
            await recoverCodeOperation(
              operationId,
              (id) => api.screenOperations.get({ operationId: id }),
              (id) => api.screenOperations.cancel({ operationId: id }),
            ),
          );
        } catch {
          setUnknown(true);
        }
      }
      await refreshScreens();
    } catch {
      setError("Could not prepare the send. Nothing was sent.");
    } finally {
      setBusy(false);
    }
  }
  const canSend = !operation || operation.status === "cancelled" || operation.status === "failed";
  return (
    <Sheet
      open={open && access}
      onClose={() => {
        setText("");
        onClose();
      }}
      title="Type the code"
      description="For one-time codes only. Keep passwords and cards in your vault."
      testID="code-sheet"
    >
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        <DesktopView
          screenId={screenId}
          mode="view"
          enabled={open && access}
          onConnectedChange={setPreviewConnected}
          style={{ aspectRatio: DESKTOP_ASPECT_RATIO }}
        />
        <Text variant="small">
          {site ? `Focused site: ${site}` : "Focus the code field in the browser to continue."}
        </Text>
        {error ? <Text variant="small">{error}</Text> : null}
        {unknown ? (
          <Text>Outcome unknown. Check the screen before sending again.</Text>
        ) : (
          operation && (
            <Text>
              {operation.status === "handed_back"
                ? "Code submitted. Your teammate can continue."
                : operation.status === "cancelled"
                  ? "Not sent. You can enter the code again."
                  : (operation.reason ?? `Code ${operation.status.replaceAll("_", " ")}.`)}
            </Text>
          )
        )}
        {canSend && !unknown && (
          <>
            <TextField
              value={text}
              onChangeText={setText}
              placeholder="One-time code"
              keyboardType="number-pad"
              maxLength={8}
              autoComplete="sms-otp"
              secureTextEntry
              autoCorrect={false}
              testID="code-input"
            />
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text variant="small">Submit after typing</Text>
              <Switch
                value={pressEnter}
                onValueChange={setPressEnter}
                trackColor={{ false: colors.input, true: colors.primary }}
                thumbColor={colors.surface}
                accessibilityLabel="Submit after typing"
              />
            </View>
            <Button
              title="Send code"
              onPress={() => void send()}
              busy={busy}
              disabled={!site || !previewConnected || !/^\d{4,8}$/.test(text)}
              testID="send-code"
            />
          </>
        )}
        <Button
          title={operation?.status === "needs_owner" || unknown ? "Check the screen" : "Close"}
          variant="outline"
          onPress={() => {
            setText("");
            onClose();
          }}
          testID="code-sheet-close"
        />
      </View>
    </Sheet>
  );
}
