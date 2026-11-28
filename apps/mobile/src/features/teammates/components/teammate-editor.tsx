import type { TeammateProfileView } from "@open-bot/api";
import { safe } from "@orpc/client";
import { router, Stack, useLocalSearchParams, useNavigation, usePreventRemove } from "expo-router";
import { CloudOff, Users } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Markdown } from "@/components/markdown";
import { LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { Notice } from "@/features/memory/components/memory-parts";
import { api } from "@/lib/api";
import { errorMessage, isGone, isStateConflict } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { radius, space, useColors } from "@/theme";
import { useTeammateProfile } from "../hooks";
import {
  clashText,
  editProfile,
  NAME_MAX,
  profileChanged,
  profileDraft,
  profileProblem,
  profileUpdate,
  rebaseProfile,
  REBASED_TEXT,
  ROLE_MAX,
  takeTheirs,
  type ProfileDraft,
  type ProfileForm,
} from "../profile";
import { AutonomyPicker, ColorPicker, EmojiField } from "./profile-parts";
import { TeammateAvatar } from "./teammate-avatar";

/** Editing a teammate's profile: its own screen, opened from the profile's Edit. */
export default function TeammateEditScreen() {
  const { teammateId } = useLocalSearchParams<{ teammateId: string }>();
  const profile = useTeammateProfile(teammateId);
  const gone = isGone(profile.error);
  // Once open, the editor stays: it says itself when the teammate is archived meanwhile.
  const [opened, setOpened] = useState<TeammateProfileView | null>(null);
  useEffect(() => {
    if (profile.data && !opened) setOpened(profile.data);
  }, [profile.data, opened]);
  if (gone && !opened)
    return (
      <NotFound
        icon={Users}
        title="This teammate is unavailable"
        body="They may have been archived, or the link may be wrong."
        action="Go to Home"
        onAction={() => router.navigate("/")}
      />
    );
  if (profile.isLoading || (profile.data && !opened)) return <Loading />;
  if (!opened)
    return (
      <LoadError
        title="Couldn't load the profile"
        error={profile.error}
        onRetry={() => void profile.refetch()}
      />
    );
  return <TeammateEditor view={profile.data ?? opened} gone={gone} />;
}

/**
 * The name, job, responsibilities, carefulness and look, as the web's profile form sets them.
 * A save sends the whole profile with the revision it started from, so one changed elsewhere
 * meanwhile is refused rather than overwritten. The form follows the profile as it changes
 * elsewhere: what you haven't touched follows it, and a field you changed that was changed there
 * too is pointed out. Leaving with changes asks first; nothing is sent while the phone is offline.
 */
function TeammateEditor({ view, gone: archived }: { view: TeammateProfileView; gone: boolean }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const online = useOnline();
  const navigation = useNavigation();
  const { teammateId } = view;
  const [draft, setDraft] = useState<ProfileDraft>(() => profileDraft(view));
  const { start, form, clashes } = draft;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A save was refused because the profile changed meanwhile, and the form followed it.
  const [rebased, setRebased] = useState(false);
  const [goneHere, setGoneHere] = useState(false);
  const [preview, setPreview] = useState(false);
  const [footer, setFooter] = useState(0);
  const [leave, setLeave] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const gone = archived || goneHere;
  const changed = profileChanged(draft);
  const invalid = profileProblem(form);
  const name = start.name;

  // A fresher copy (it changed on the web, say): what you haven't touched follows it. Not while a
  // save is on its way: the form is frozen, and the save's own answer comes next.
  useEffect(() => {
    if (!busy) setDraft((current) => rebaseProfile(current, view));
  }, [view, busy]);

  // Back to the profile once a save went through, after the guard below has let go, and only
  // while the editor is still on screen; opened from a link, the profile takes its place.
  useEffect(() => {
    if (!leave || !navigation.isFocused()) return;
    if (router.canGoBack()) router.back();
    else router.replace(`/teammates/${teammateId}`);
  }, [leave, navigation, teammateId]);

  // Discard lets go of the guard and goes on with the leaving it held: `repeat`, since that same
  // leaving dispatched again would be held again.
  usePreventRemove(changed && !leave && !gone && !discarded, ({ repeat }) =>
    Alert.alert("Discard your changes?", `What you changed in ${name}'s profile isn't saved.`, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          setDiscarded(true);
          repeat();
        },
      },
    ]),
  );

  const set = (patch: Partial<ProfileForm>) => {
    if (busy) return;
    setProblem(null);
    setDraft((current) => editProfile(current, patch));
  };

  async function save() {
    if (invalid) {
      setProblem(invalid);
      haptics.warning();
      return;
    }
    setBusy(true);
    setProblem(null);
    const sent = profileUpdate(teammateId, draft);
    const result = await safe(api.teammates.update(sent));
    if (result.error) {
      haptics.error();
      if (isGone(result.error)) {
        setGoneHere(true);
        setBusy(false);
      } else if (isStateConflict(result.error)) await followRefusal();
      else {
        setProblem(errorMessage(result.error, "Couldn't save the profile."));
        setBusy(false);
      }
      return;
    }
    // What was sent is saved: the form starts from it, at the revision the save answered with.
    const saved = { teammateId, profile: sent.profile, revision: result.data.revision };
    queryClient.setQueryData(queryKeys.teammateProfile(teammateId), saved);
    void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
    setDraft(profileDraft(saved));
    setRebased(false);
    setBusy(false);
    haptics.success();
    setLeave(true);
  }

  /** Refused as changed meanwhile: read it again, and put what you changed on top of it. */
  async function followRefusal() {
    const fresh = await safe(
      queryClient.fetchQuery({
        queryKey: queryKeys.teammateProfile(teammateId),
        queryFn: () => api.teammates.profile({ teammateId }),
        staleTime: 0,
      }),
    );
    setBusy(false);
    if (fresh.error) {
      if (isGone(fresh.error)) setGoneHere(true);
      else setProblem(errorMessage(fresh.error, "Couldn't load the latest version."));
      return;
    }
    setDraft((current) => rebaseProfile(current, fresh.data));
    setRebased(true);
  }

  const clash = clashText(draft);
  const canSave = online && !busy && changed && !invalid && !gone;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: "Edit profile" }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: footer + space(6) }]}
        testID="teammate-editor"
      >
        {gone && (
          <Notice testID="teammate-editor-gone">
            {`${name} was archived, so changes here can't be saved.`}
          </Notice>
        )}
        {!gone && rebased && changed && !clash && (
          <Notice tone="attention" testID="teammate-editor-rebased">
            {REBASED_TEXT}
          </Notice>
        )}
        {!gone && clash && (
          <Notice
            tone="attention"
            stacked
            testID="teammate-editor-clash"
            action={
              <Button
                title={clashes.length === 1 ? "Use the saved version" : "Use the saved versions"}
                variant="outline"
                disabled={busy}
                onPress={() => {
                  haptics.tap();
                  setDraft((current) =>
                    current.clashes.reduce((next, field) => takeTheirs(next, field), current),
                  );
                }}
                testID="teammate-editor-theirs"
              />
            }
          >
            {clash}
          </Notice>
        )}

        <View style={styles.look}>
          <TeammateAvatar
            name={form.name.trim() || "?"}
            color={form.color}
            emoji={form.emoji}
            size="profile"
          />
          <View style={{ flex: 1 }}>
            <Field label="Emoji">
              <EmojiField
                value={form.emoji}
                onChange={(emoji) => set({ emoji })}
                disabled={busy || gone}
              />
            </Field>
          </View>
        </View>
        <Field label="Color">
          <ColorPicker
            value={form.color}
            onChange={(color) => set({ color })}
            disabled={busy || gone}
          />
        </Field>

        <Field label="Name">
          <TextField
            value={form.name}
            onChangeText={(value) => set({ name: value })}
            editable={!busy && !gone}
            maxLength={NAME_MAX}
            placeholder="e.g. Nova"
            returnKeyType="done"
            testID="teammate-name-input"
          />
        </Field>
        <Field label="Job">
          <TextField
            value={form.role}
            onChangeText={(role) => set({ role })}
            editable={!busy && !gone}
            maxLength={ROLE_MAX}
            placeholder="e.g. Research assistant"
            returnKeyType="done"
            testID="teammate-role-input"
          />
        </Field>
        <Field
          label="What they're responsible for"
          action={
            <Pressable
              onPress={() => {
                haptics.tap();
                setPreview((value) => !value);
              }}
              accessibilityRole="button"
              hitSlop={8}
              testID="teammate-instructions-preview"
            >
              <Text variant="small" style={{ fontWeight: "600" }}>
                {preview ? "Write" : "Preview"}
              </Text>
            </Pressable>
          }
        >
          {preview ? (
            <View
              style={[
                styles.preview,
                { backgroundColor: colors.surface, borderColor: colors.input },
              ]}
            >
              {form.instructions.trim() ? (
                <Markdown text={form.instructions} />
              ) : (
                <Text muted>Nothing to preview yet.</Text>
              )}
            </View>
          ) : (
            <TextField
              value={form.instructions}
              onChangeText={(instructions) => set({ instructions })}
              editable={!busy && !gone}
              multiline
              placeholder="Describe the job: what to do, how you like it done, and what to stay away from."
              style={styles.instructions}
              testID="teammate-instructions-input"
            />
          )}
          <Text variant="caption" muted style={styles.inset}>
            This becomes their instructions file. They also keep their own memory of what they learn
            about you.
          </Text>
        </Field>
        <Field label="When they ask you first">
          <AutonomyPicker
            value={form.autonomy}
            onChange={(autonomy) => set({ autonomy })}
            disabled={busy || gone}
          />
        </Field>
        <Text variant="small" muted style={styles.inset}>
          {`${name} uses the new profile from the next message. Skills, spending and importing teammates are in open-bot on a computer.`}
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
          <View style={styles.offline} testID="teammate-editor-offline">
            <CloudOff size={14} color={colors.mutedForeground} />
            <Text variant="caption" muted style={{ flex: 1 }}>
              You're offline. Your changes stay here until you're back.
            </Text>
          </View>
        ) : problem ? (
          <Text
            variant="small"
            style={{ color: colors.destructive }}
            testID="teammate-editor-problem"
          >
            {problem}
          </Text>
        ) : changed && invalid ? (
          <Text
            variant="small"
            style={{ color: colors.destructive }}
            testID="teammate-editor-problem"
          >
            {invalid}
          </Text>
        ) : null}
        <Button
          title="Save"
          onPress={() => void save()}
          disabled={!canSave}
          busy={busy}
          testID="teammate-save"
        />
      </View>
    </View>
  );
}

function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: space(2) }}>
      <View style={[styles.label, styles.inset]}>
        <Text variant="overline" muted style={{ flex: 1 }}>
          {label}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(5) },
  inset: { paddingHorizontal: space(1) },
  label: { flexDirection: "row", alignItems: "center", gap: space(3) },
  look: { flexDirection: "row", alignItems: "center", gap: space(4) },
  instructions: { minHeight: 180 },
  preview: {
    minHeight: 180,
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
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
