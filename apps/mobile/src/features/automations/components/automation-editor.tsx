import { intervalChoices, leadChoices, timingSummary, viewerTimeZone } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { router, Stack, useLocalSearchParams, useNavigation, usePreventRemove } from "expo-router";
import { CalendarClock, CloudOff } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage, isGone } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";
import {
  AUTOMATIONS_HREF,
  automationForm,
  automationHref,
  editorReturnsToAutomation,
  formChanged,
  formProblem,
  isAutomationType,
  kindName,
  patchOf,
  quietNote,
  rebaseForm,
  stateBadge,
  TITLE_MAX,
  webOnlyNote,
  zoneNote,
  type Automation,
  type AutomationDraft,
  type AutomationForm,
} from "../automations";
import { useAutomation } from "../hooks";
import { Choices } from "./automation-parts";
import { TimingFields } from "./timing-fields";

const phoneZone = viewerTimeZone;

/** Renaming an automation and changing its timing, on its own screen. */
export default function AutomationEditScreen() {
  const params = useLocalSearchParams<{ kind: string; automationId: string }>();
  const type = isAutomationType(params.kind) ? params.kind : "schedule";
  const { automation, gone, isLoading, error, refetch } = useAutomation(type, params.automationId);
  // Once open, the editor stays: it says itself when the automation is deleted meanwhile.
  const [opened, setOpened] = useState<Automation | null>(null);
  useEffect(() => {
    if (automation && !opened) setOpened(automation);
  }, [automation, opened]);
  if (!isAutomationType(params.kind) || (gone && !opened))
    return (
      <NotFound
        icon={CalendarClock}
        title="This automation is gone"
        body="It was deleted, or the link is wrong."
        action="See automations"
        onAction={() => router.replace(AUTOMATIONS_HREF)}
      />
    );
  if (isLoading || (automation && !opened)) return <Loading />;
  if (!opened)
    return <LoadError error={error} onRetry={() => void refetch()} title="Couldn't load it" />;
  return <AutomationEditor automation={automation ?? opened} gone={gone} />;
}

/**
 * The name, and when it runs or how often it looks, as the web's dialog sets them. Only what you
 * change is sent (`schedules.patch`, `triggers.patch`), so an edit made on the web meanwhile stays,
 * and what you haven't touched follows the automation as it changes elsewhere. Leaving with
 * changes asks first; nothing is sent while the phone is offline, and the draft stays here.
 */
function AutomationEditor({
  automation,
  gone: deleted,
}: {
  automation: Automation;
  gone: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const online = useOnline();
  const navigation = useNavigation();
  const [draft, setDraft] = useState<AutomationDraft>(() => {
    const start = automationForm(automation);
    return { start, form: start };
  });
  const { start, form } = draft;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [goneHere, setGoneHere] = useState(false);
  const [footer, setFooter] = useState(0);
  const [leave, setLeave] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const gone = deleted || goneHere;
  const changed = formChanged(start, form);
  const invalid = formProblem(automation, form);

  // A fresher copy (it changed on the web, say): what you haven't touched follows it. Not while a
  // save is on its way: the form is frozen, and the save's own answer comes next.
  useEffect(() => {
    if (!busy) setDraft((current) => rebaseForm(current, automationForm(automation)));
  }, [automation, busy]);

  // To the automation once a save went through, after the guard below has let go: back to its
  // screen when that's under the editor, or in the editor's place when the editor was opened from
  // a link, and only while it's still on screen (you may have gone elsewhere while it saved).
  useEffect(() => {
    if (!leave || !navigation.isFocused()) return;
    const { routes, index } = navigation.getState() ?? { routes: [], index: 0 };
    if (editorReturnsToAutomation(routes[index - 1], automation)) router.back();
    else router.replace(automationHref(automation));
  }, [leave, navigation, automation]);

  // Discard lets go of the guard and goes on with the leaving it held: `repeat`, since that same
  // leaving dispatched again would be held again.
  usePreventRemove(changed && !leave && !gone && !discarded, ({ repeat }) =>
    Alert.alert(
      "Discard your changes?",
      `What you changed in this ${kindName(automation)} isn't saved.`,
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            setDiscarded(true);
            repeat();
          },
        },
      ],
    ),
  );

  const set = (patch: Partial<AutomationForm>) => {
    if (busy) return;
    setProblem(null);
    setDraft((current) => ({ ...current, form: { ...current.form, ...patch } }));
  };

  async function save() {
    if (invalid) {
      setProblem(invalid);
      haptics.warning();
      return;
    }
    const write = patchOf(automation, start, form);
    if (!write) return;
    setBusy(true);
    setProblem(null);
    const result = await safe(
      write.type === "schedule"
        ? api.schedules.patch(write.patch)
        : api.triggers.patch(write.patch),
    );
    void queryClient.invalidateQueries({
      queryKey: automation.type === "schedule" ? queryKeys.schedules : queryKeys.triggers,
    });
    setBusy(false);
    if (result.error) {
      haptics.error();
      if (isGone(result.error)) setGoneHere(true);
      else setProblem(errorMessage(result.error, "Couldn't save it."));
      return;
    }
    haptics.success();
    setDraft((current) => ({ start: current.form, form: current.form }));
    setLeave(true);
  }

  const badge = stateBadge(automation);
  const quiet = quietNote(automation, form);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: `Edit ${kindName(automation)}` }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: footer + space(6) }]}
        testID="automation-editor"
      >
        {gone && (
          <View
            style={[styles.notice, { backgroundColor: colors.subtle }]}
            testID="automation-gone"
          >
            <Text variant="small" muted>
              This {kindName(automation)} was deleted, so changes here can't be saved.
            </Text>
          </View>
        )}
        <Field label="Name">
          <TextField
            value={form.title}
            onChangeText={(title) => set({ title })}
            editable={!busy}
            maxLength={TITLE_MAX}
            returnKeyType="done"
            testID="automation-title-input"
          />
        </Field>
        {automation.type === "schedule" && form.timing && (
          <Field label="When">
            <TimingFields
              value={form.timing}
              onChange={(patch) => set({ timing: { ...form.timing!, ...patch } })}
              disabled={busy}
              timeZone={automation.timezone}
              repeatsOnly={automation.checkIn}
              summary={
                <>
                  <Text variant="small" muted testID="timing-summary">
                    {timingSummary(form.timing)}
                  </Text>
                  <Text variant="caption" muted>
                    {zoneNote(automation.timezone, phoneZone())}
                  </Text>
                  {quiet && (
                    <Text variant="caption" muted testID="automation-quiet">
                      {quiet}
                    </Text>
                  )}
                  {badge === "Done" && (
                    <Text variant="caption" muted>
                      It already ran. Give it a new time to run it again.
                    </Text>
                  )}
                </>
              }
            />
          </Field>
        )}
        {form.intervalMinutes !== null && (
          <Field label="Check the page">
            <Choices
              options={intervalChoices(start.intervalMinutes).map((option) => ({
                key: option.minutes,
                label: option.label,
              }))}
              value={form.intervalMinutes}
              onChange={(intervalMinutes) => set({ intervalMinutes })}
              disabled={busy}
              testID="interval"
            />
          </Field>
        )}
        {form.leadMinutes !== null && (
          <Field label="Wake them">
            <Choices
              options={leadChoices(start.leadMinutes).map((option) => ({
                key: option.minutes,
                label: option.label,
              }))}
              value={form.leadMinutes}
              onChange={(leadMinutes) => set({ leadMinutes })}
              disabled={busy}
              testID="lead"
            />
          </Field>
        )}
        <Text variant="small" muted style={styles.inset}>
          {webOnlyNote(automation)}
        </Text>
      </ScrollView>

      <View
        onLayout={(event) => setFooter(event.nativeEvent.layout.height)}
        style={[
          styles.footer,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            bottom: keyboard,
            paddingBottom: (keyboard > 0 ? 0 : insets.bottom) + space(3),
          },
        ]}
      >
        {!online ? (
          <View style={styles.offline} testID="automation-offline">
            <CloudOff size={14} color={colors.mutedForeground} />
            <Text variant="caption" muted style={{ flex: 1 }}>
              You're offline. Your changes stay here until you're back.
            </Text>
          </View>
        ) : problem ? (
          <Text variant="small" style={{ color: colors.destructive }} testID="automation-problem">
            {problem}
          </Text>
        ) : changed && invalid ? (
          <Text variant="small" style={{ color: colors.destructive }} testID="automation-problem">
            {invalid}
          </Text>
        ) : null}
        <Button
          title="Save"
          onPress={() => void save()}
          disabled={!online || busy || !changed || Boolean(invalid) || gone}
          busy={busy}
          testID="automation-save"
        />
      </View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="overline" muted style={styles.inset}>
        {label}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(5) },
  inset: { paddingHorizontal: space(1) },
  notice: { borderRadius: 12, padding: space(3) },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(4),
    paddingTop: space(3),
    gap: space(2.5),
  },
  offline: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
