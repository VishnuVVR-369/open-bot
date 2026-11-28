import { copyName } from "@open-bot/domain";
import * as Crypto from "expo-crypto";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { CloudOff, Users } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Card } from "@/components/section";
import { Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { Toggle } from "@/components/toggle";
import { useOnline } from "@/lib/network";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";
import { duplicateTeammate } from "../actions";
import { useTeammates } from "../hooks";
import { NAME_MAX } from "../profile";
import { TeammateAvatar } from "./teammate-avatar";

/**
 * A new teammate set up like this one, as the web's Duplicate does: a name for it, and whether
 * it takes this teammate's memory along. The new teammate opens once it's made.
 */
export default function DuplicateTeammateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const online = useOnline();
  const navigation = useNavigation();
  const { teammateId } = useLocalSearchParams<{ teammateId: string }>();
  const teammates = useTeammates();
  const team = teammates.data;
  const teammate = team?.find((entry) => entry.id === teammateId);
  const [name, setName] = useState<string | null>(null);
  const [copyMemory, setCopyMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [footer, setFooter] = useState(0);
  // One copy per ask: a retry after a lost answer names the same id, so the server answers it with
  // the copy the first ask made instead of a second one. That copy has the first ask's name, kept
  // here for what the screen says. A refusal means nothing was made, so the next ask is a new one.
  const sent = useRef<{ copyId: string; name: string } | null>(null);

  // The suggested name, once the team is known; what you type then stays.
  useEffect(() => {
    if (teammate && team && name === null)
      setName(
        copyName(
          teammate.name,
          team.map((entry) => entry.name),
        ),
      );
  }, [teammate, team, name]);

  if (teammates.isLoading) return <Loading />;
  if (!teammate && !busy)
    return (
      <NotFound
        icon={Users}
        title="This teammate is unavailable"
        body="They may have been archived, or the link may be wrong."
        action="Go to Home"
        onAction={() => router.navigate("/")}
      />
    );
  if (!teammate) return <Loading />;

  const value = name ?? "";
  const canSave = online && !busy && value.trim().length > 0;

  async function duplicate() {
    if (!teammate || !canSave) return;
    setBusy(true);
    setProblem(null);
    const ask = (sent.current ??= { copyId: Crypto.randomUUID(), name: value.trim() });
    const outcome = await duplicateTeammate({
      teammateId: teammate.id,
      name: value.trim(),
      copyMemory,
      copyId: ask.copyId,
    });
    if (!outcome.ok) {
      if (outcome.refused) sent.current = null;
      setBusy(false);
      setProblem(outcome.message);
      return;
    }
    sent.current = null;
    // Left meanwhile: the copy is on the team, and the app stays where you went.
    if (!navigation.isFocused()) {
      setBusy(false);
      return;
    }
    if (!outcome.memoryCopied)
      Alert.alert(
        `${ask.name} is ready, without ${teammate.name}'s memory`,
        "The computer couldn't copy it. You can add what they should know in their Memory.",
      );
    router.replace(`/teammates/${outcome.teammateId}`);
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: `Duplicate ${teammate.name}` }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: footer + space(6) }]}
        testID="teammate-duplicate"
      >
        <View style={styles.hero}>
          <TeammateAvatar {...teammate} size="lg" />
          <Text muted style={{ flex: 1 }}>
            {`The new teammate gets ${teammate.name}'s job and instructions, their own copies of the skills and what they may do without asking, and the schedules and page watches, turned off. Chats and webhooks stay with ${teammate.name}.`}
          </Text>
        </View>
        <View style={{ gap: space(2) }}>
          <Text variant="overline" muted style={styles.inset}>
            Name
          </Text>
          <TextField
            value={value}
            onChangeText={(text) => {
              setProblem(null);
              setName(text);
            }}
            editable={!busy}
            maxLength={NAME_MAX}
            returnKeyType="done"
            onSubmitEditing={() => void duplicate()}
            testID="duplicate-name-input"
          />
        </View>
        <Card>
          <Pressable
            onPress={() => !busy && setCopyMemory((on) => !on)}
            disabled={busy}
            accessibilityRole="switch"
            accessibilityState={{ checked: copyMemory, disabled: busy }}
            accessibilityLabel="Copy their memory"
            android_ripple={{ color: colors.muted }}
            style={styles.toggleRow}
            testID="duplicate-memory"
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="label">Copy their memory</Text>
              <Text variant="small" muted>
                {`What ${teammate.name} has learned about you and how you like things done, including lessons from your feedback.`}
              </Text>
            </View>
            <Toggle
              value={copyMemory}
              disabled={busy}
              importantForAccessibility="no-hide-descendants"
            />
          </Pressable>
        </Card>
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
          <View style={styles.offline} testID="duplicate-offline">
            <CloudOff size={14} color={colors.mutedForeground} />
            <Text variant="caption" muted style={{ flex: 1 }}>
              You're offline. Duplicate once you're back.
            </Text>
          </View>
        ) : problem ? (
          <Text variant="small" style={{ color: colors.destructive }} testID="duplicate-problem">
            {problem}
          </Text>
        ) : null}
        <Button
          title="Duplicate"
          onPress={() => void duplicate()}
          disabled={!canSave}
          busy={busy}
          testID="duplicate-confirm"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(5) },
  inset: { paddingHorizontal: space(1) },
  hero: { flexDirection: "row", alignItems: "flex-start", gap: space(3) },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
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
