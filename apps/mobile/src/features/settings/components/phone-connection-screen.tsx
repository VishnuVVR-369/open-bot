import { describeEgress } from "@open-bot/api";
import { PHONE_MODE_OPTIONS, type PhoneMode } from "@open-bot/domain";
import { fileSize } from "@open-bot/chat-core";
import notifee from "@notifee/react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as Device from "expo-device";
import {
  BatteryLow,
  BellOff,
  ChartNoAxesColumn,
  Gauge,
  Moon,
  Play,
  Power,
  Shuffle,
  Smartphone,
  Square,
  Wifi,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, Linking, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import NativeEgress from "../../../../modules/egress";
import { Button } from "@/components/button";
import { Separator } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { Sheet, SheetItem } from "@/components/sheet";
import { Text } from "@/components/text";
import {
  ChoiceRow,
  Dot,
  Notice,
  PathIcon,
  pathTone,
  toneColor,
} from "@/features/settings/components/phone-connection-parts";
import {
  SETTINGS_INSET,
  SettingsRow,
  SettingsSwitch,
} from "@/features/settings/components/settings-row";
import { useEgressDevices, useEgressStatus, useNativeEgress } from "@/features/settings/hooks";
import {
  CAP_CHOICES,
  capLabel,
  lastUsedLabel,
  needsBatteryHelp,
  notificationProblem,
  pairPhone,
  phoneState,
  turnOffThisPhone,
} from "@/features/settings/phone-connection";
import { api } from "@/lib/api";
import { APP_URL } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { currentPushToken } from "@/push/register";
import { space, useColors } from "@/theme";

/** Asks for the notification permission when Android still can, then reads what is allowed. */
async function notificationAccess() {
  if (!NativeEgress.notificationsAllowed().permission) await notifee.requestPermission();
  return NativeEgress.notificationsAllowed();
}

/**
 * Settings → Phone connection: this phone can carry teammates' browsing when the Mac is offline,
 * or always. Off, it explains the cost and pairs; on, it shows where traffic goes, this phone's
 * state and data, when it helps, its rules and every paired phone.
 */
export default function PhoneConnection() {
  const colors = useColors();
  const bottom = useSafeBottom();
  const queryClient = useQueryClient();
  const native = useNativeEgress();
  const status = useEgressStatus(native.status.paired);
  const devices = useEgressDevices();
  const { refreshing, onRefresh } = usePullToRefresh(async () => {
    native.refresh();
    await Promise.all([status.refetch(), devices.refetch()]);
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [capOpen, setCapOpen] = useState(false);
  const deviceId = NativeEgress.deviceId();
  const paired = native.status.paired;
  const problem = notificationProblem(native.notifications);

  /** Runs one change at a time, says what went wrong, and refreshes what it may have changed. */
  async function act(name: string, work: () => Promise<unknown>) {
    setBusy(name);
    try {
      await work();
    } catch (error) {
      haptics.error();
      Alert.alert("Couldn't change the phone connection", errorMessage(error));
    } finally {
      setBusy(null);
      native.refresh();
      void queryClient.invalidateQueries({ queryKey: queryKeys.egress });
      void queryClient.invalidateQueries({ queryKey: queryKeys.egressDevices });
    }
  }

  function pair() {
    void act("pair", async () => {
      const result = await pairPhone({
        notifications: notificationAccess,
        deviceId: () => deviceId,
        deviceName: () => Device.modelName ?? "Android phone",
        pushToken: currentPushToken,
        serverPhoneMode: () => status.data?.phoneMode ?? "fallback",
        register: (input) => api.egress.registerDevice(input),
        setServerPhoneMode: (mode) => api.egress.setPhoneMode({ mode }),
        pair: (options) => NativeEgress.pair({ ...options, appUrl: APP_URL }),
        revoke: (input) => api.egress.revokeDevice(input),
      });
      if (result.ok) haptics.success();
      else haptics.warning();
    });
  }

  function setPhoneMode(mode: PhoneMode) {
    if (mode === status.data?.phoneMode) return;
    haptics.tap();
    void act("mode", async () => {
      await api.egress.setPhoneMode({ mode });
      await NativeEgress.setPhoneMode(mode);
    });
  }

  function setRules(change: Partial<typeof native.status.rules>) {
    void act("rules", () => NativeEgress.setRules({ ...native.status.rules, ...change }));
  }

  function confirmTurnOff() {
    haptics.warning();
    Alert.alert(
      "Turn off for this phone?",
      "It stops carrying teammates' browsing, and the server forgets it. You can turn it on again here.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Turn off",
          style: "destructive",
          onPress: () =>
            void act("off", () =>
              turnOffThisPhone({
                status: () => NativeEgress.status(),
                deviceId: () => deviceId,
                forget: () => NativeEgress.forget(),
                revoke: (input) => api.egress.revokeDevice(input),
              }),
            ),
        },
      ],
    );
  }

  function confirmRevoke(device: { id: string; name: string }) {
    haptics.warning();
    Alert.alert(`Remove ${device.name}?`, "It stops carrying teammates' browsing right away.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void act(`revoke:${device.id}`, () => api.egress.revokeDevice({ deviceId: device.id })),
      },
    ]);
  }

  const notificationsNotice =
    problem === null ? null : (
      <Notice
        icon={(color) => <BellOff size={18} color={color} />}
        title={
          problem === "permission"
            ? "Notifications are off for open-bot"
            : "The Phone connection notifications are off"
        }
        body="Without them you won't see “Tap to start” when teammates need this phone, or why it paused."
        action="Open notification settings"
        onAction={() =>
          void (problem === "channel"
            ? notifee.openNotificationSettings("connection")
            : notifee.openNotificationSettings())
        }
        testID="phone-notifications-off"
      />
    );

  const refresh = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      colors={[colors.foreground]}
      progressBackgroundColor={colors.surface}
    />
  );

  if (!paired) {
    const state = phoneState(native.status);
    return (
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
        refreshControl={refresh}
        testID="phone-connection-off"
      >
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: colors.subtle }]}>
            <Smartphone size={26} color={colors.foreground} />
          </View>
          <Text variant="title">Browse through this phone</Text>
          <Text muted>
            Websites often block cloud computers. When your Mac is offline, teammates&apos; browser
            can go online through this phone instead, so sites see your phone&apos;s connection.
          </Text>
          {state.tone === "attention" && state.detail ? (
            <Text variant="small" style={{ color: colors.attentionInk }}>
              {state.detail}
            </Text>
          ) : null}
        </View>
        <Card>
          <SettingsRow
            icon={(color) => <Wifi size={18} color={color} />}
            title="Data"
            subtitle="Pages teammates load use this phone's data. It sticks to Wi-Fi unless you allow mobile data, with a monthly limit."
          />
          <Separator inset={SETTINGS_INSET} />
          <SettingsRow
            icon={(color) => <BatteryLow size={18} color={color} />}
            title="Battery"
            subtitle="It runs only while teammates browse, shows a notification while it does, and pauses when the battery is low."
          />
          <Separator inset={SETTINGS_INSET} />
          <SettingsRow
            icon={(color) => <Shuffle size={18} color={color} />}
            title="Sites may notice the switch"
            subtitle="When traffic moves between your Mac, this phone and the cloud, some sites ask teammates to sign in again."
          />
        </Card>
        {notificationsNotice}
        <Button
          title="Use this phone's connection"
          onPress={pair}
          busy={busy === "pair"}
          testID="phone-pair"
        />
      </ScrollView>
    );
  }

  const egress = status.data;
  const path = egress ? describeEgress(egress) : null;
  const state = phoneState(native.status);
  const { service, usage, rules } = native.status;
  const running = service.running;

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
      refreshControl={refresh}
      testID="phone-connection-on"
    >
      <Section title="Now">
        <Card>
          {egress && path ? (
            <SettingsRow
              icon={(color) => <PathIcon path={egress.path} size={18} color={color} />}
              title={path.label}
              subtitle={path.detail ?? "Where teammates' browser goes online"}
              aside={<Dot color={toneColor(pathTone(egress.path), colors)} />}
              testID="phone-path"
            />
          ) : (
            <SettingsRow
              icon={(color) => <PathIcon path="direct" size={18} color={color} />}
              title="Checking where traffic goes"
              subtitle={status.error ? errorMessage(status.error) : null}
            />
          )}
          <Separator inset={SETTINGS_INSET} />
          <SettingsRow
            icon={(color) => <Smartphone size={18} color={color} />}
            title={state.label}
            subtitle={state.detail ?? "This phone"}
            aside={<Dot color={toneColor(state.tone, colors)} />}
            testID="phone-state"
          />
          <Separator inset={SETTINGS_INSET} />
          <SettingsRow
            icon={(color) => <ChartNoAxesColumn size={18} color={color} />}
            title={`${fileSize(usage.todayBytes)} today`}
            subtitle={`${fileSize(usage.monthBytes)} this month, ${fileSize(usage.monthMeteredBytes)} of it on mobile data`}
            testID="phone-usage"
          />
          <View style={styles.cardFooter}>
            {running ? (
              <Button
                title="Stop"
                variant="outline"
                icon={<Square size={16} color={colors.foreground} />}
                onPress={() => void act("stop", () => NativeEgress.stop())}
                busy={busy === "stop"}
                testID="phone-stop"
              />
            ) : (
              <Button
                title="Start now"
                variant="outline"
                icon={<Play size={16} color={colors.foreground} />}
                onPress={() => void act("start", () => NativeEgress.start())}
                busy={busy === "start"}
                testID="phone-start"
              />
            )}
          </View>
        </Card>
      </Section>

      {notificationsNotice}
      {egress?.mode === "off" && (
        <Notice
          icon={(color) => <Power size={18} color={color} />}
          title="Browsing through your devices is off"
          body="Teammates browse straight from the cloud, so this phone never carries traffic."
          action="Turn it on"
          busy={busy === "egress-mode"}
          onAction={() => void act("egress-mode", () => api.egress.setMode({ mode: "prefer" }))}
          testID="phone-egress-off"
        />
      )}
      {needsBatteryHelp(egress, deviceId, native.battery) && (
        <Notice
          icon={(color) => <BatteryLow size={18} color={color} />}
          title="This phone didn't answer"
          body={
            native.battery.miui
              ? "Android may be holding open-bot back to save battery. Allow it to run in the background, and turn on Autostart for open-bot in Settings → Apps."
              : "Android may be holding open-bot back to save battery. Allow it to run in the background."
          }
          action="Allow in background"
          onAction={() => void NativeEgress.openBatteryOptimizationSettings()}
          testID="phone-battery"
        />
      )}
      {native.standby.enabled && !native.standby.exempt && (
        <Notice
          icon={(color) => <Moon size={18} color={color} />}
          title="Low Power Standby is on"
          body="Android cuts this phone's connection while the screen is off. Turn it off in Settings → Battery to keep browsing going."
          action="Open settings"
          onAction={() => void Linking.openSettings()}
          testID="phone-standby"
        />
      )}

      <Section title="When it helps">
        <Card>
          {PHONE_MODE_OPTIONS.map((option, index) => (
            <View key={option.value}>
              {index > 0 && <Separator inset={space(4) + 20 + space(3)} />}
              <ChoiceRow
                title={option.label}
                description={option.description}
                checked={egress?.phoneMode === option.value}
                disabled={!egress || busy === "mode"}
                onPress={() => setPhoneMode(option.value)}
                testID={`phone-mode-${option.value}`}
              />
            </View>
          ))}
        </Card>
        <Text variant="small" muted style={styles.footnote}>
          This applies to every paired phone.
        </Text>
      </Section>

      <Section title="Rules for this phone">
        <Card>
          <SettingsSwitch
            icon={(color) => <Wifi size={18} color={color} />}
            title="Wi-Fi only"
            subtitle="Pause on mobile data instead of using it"
            value={rules.wifiOnly}
            onChange={(value) => setRules({ wifiOnly: value })}
            disabled={busy === "rules"}
            testID="phone-wifi-only"
          />
          <Separator inset={SETTINGS_INSET} />
          <SettingsRow
            icon={(color) => <Gauge size={18} color={color} />}
            title="Mobile data limit"
            subtitle={
              rules.monthlyCapBytes === 0
                ? "No monthly limit"
                : `Pauses after ${capLabel(rules.monthlyCapBytes)} of mobile data a month`
            }
            aside={
              <Text variant="small" muted>
                {capLabel(rules.monthlyCapBytes)}
              </Text>
            }
            onPress={() => setCapOpen(true)}
            testID="phone-cap"
          />
          <Separator inset={SETTINGS_INSET} />
          <SettingsSwitch
            icon={(color) => <BatteryLow size={18} color={color} />}
            title="Pause on low battery"
            subtitle="Below 20% and not charging"
            value={rules.lowBatteryPause}
            onChange={(value) => setRules({ lowBatteryPause: value })}
            disabled={busy === "rules"}
            testID="phone-low-battery"
          />
        </Card>
      </Section>

      <Section title="Paired phones">
        <Card>
          {(devices.data ?? []).map((device, index) => {
            const self = device.id === deviceId;
            return (
              <View key={device.id}>
                {index > 0 && <Separator inset={SETTINGS_INSET} />}
                <SettingsRow
                  icon={(color) => <Smartphone size={18} color={color} />}
                  title={self ? `${device.name} (this phone)` : device.name}
                  subtitle={lastUsedLabel(device, ago)}
                  aside={
                    self ? null : (
                      <Button
                        title="Remove"
                        variant="ghost"
                        onPress={() => confirmRevoke(device)}
                        busy={busy === `revoke:${device.id}`}
                        testID={`phone-revoke-${device.id}`}
                      />
                    )
                  }
                  testID={`paired-${device.id}`}
                />
              </View>
            );
          })}
          {devices.data?.length ? <Separator inset={0} /> : null}
          <SettingsRow
            icon={(color) => <Power size={18} color={color} />}
            title="Turn off for this phone"
            destructive
            busy={busy === "off"}
            onPress={confirmTurnOff}
            testID="phone-turn-off"
          />
        </Card>
      </Section>

      <Sheet
        open={capOpen}
        onClose={() => setCapOpen(false)}
        title="Mobile data limit"
        description="Each month, this phone pauses after using this much mobile data for teammates. Wi-Fi doesn't count."
        testID="phone-cap-sheet"
      >
        {CAP_CHOICES.map((choice) => (
          <SheetItem
            key={choice.bytes}
            icon={
              <Dot
                color={choice.bytes === rules.monthlyCapBytes ? colors.foreground : "transparent"}
              />
            }
            label={choice.label}
            onPress={() => {
              setCapOpen(false);
              setRules({ monthlyCapBytes: choice.bytes });
            }}
            testID={`phone-cap-${choice.bytes}`}
          />
        ))}
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(6) },
  hero: { gap: space(2.5), paddingHorizontal: space(1), paddingTop: space(2) },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space(1),
  },
  cardFooter: { paddingHorizontal: space(4), paddingBottom: space(4), paddingTop: space(1) },
  footnote: { paddingHorizontal: space(1), marginTop: -space(1) },
});
