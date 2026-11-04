import type { RunView } from "@open-bot/api";
import { compactNumber, formatDollars, formatDuration, MAX_LESSON_CHARS } from "@open-bot/shared";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import {
  Check,
  Copy,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, View, type TextInputInstance } from "react-native";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/query";
import { readAloud, readingNow, stopReading, useReading } from "@/lib/read-aloud";
import { space, useColors } from "@/theme";

type Rating = RunView["rating"];

/** How long a run took and what it used, like "Took 42s · 12K tokens · $0.03". */
export function usageLine(run: RunView): string | null {
  const took =
    run.startedAt && run.completedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  const parts = [
    took !== null && `Took ${formatDuration(took)}`,
    run.usage && run.usage.tokens > 0 && `${compactNumber(run.usage.tokens)} tokens`,
    run.usage && run.usage.costMicros > 0 && formatDollars(run.usage.costMicros),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function IconButton({
  icon: Icon,
  label,
  onPress,
  active,
  filled,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  filled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const color = active ? colors.foreground : colors.mutedForeground;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      android_ripple={{ color: colors.muted, borderless: true, radius: 18 }}
      hitSlop={4}
      style={styles.icon}
      testID={testID}
    >
      <Icon size={16} color={color} fill={filled ? color : "transparent"} />
    </Pressable>
  );
}

/** Runs a failed or stopped request again. */
export function RetryRun({ runId, chatId }: { runId: string; chatId: string }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View style={{ gap: space(1) }}>
      <Pressable
        onPress={async () => {
          setBusy(true);
          setProblem(null);
          const result = await safe(api.runs.retry({ runId }));
          setBusy(false);
          if (result.error) setProblem(errorMessage(result.error, "Couldn't try again."));
          else void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
        }}
        disabled={busy}
        accessibilityRole="button"
        style={[styles.retry, busy && { opacity: 0.5 }]}
        hitSlop={6}
        testID="retry-run"
      >
        <RotateCcw size={14} color={colors.mutedForeground} />
        <Text variant="small" muted>
          {busy ? "Trying again…" : "Try again"}
        </Text>
      </Pressable>
      {problem && (
        <Text variant="small" style={{ color: colors.destructive }}>
          {problem}
        </Text>
      )}
    </View>
  );
}

/**
 * Under a finished reply: copy it, hear it, rate it (a thumbs down asks what to change), and what
 * it took.
 */
export function RunActions({
  run,
  chatId,
  botName,
  reply,
}: {
  run: RunView;
  chatId: string;
  botName: string;
  reply: string;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const reading = useReading() === run.id;
  const [copied, setCopied] = useState(false);
  // What you just picked, until the chat reloads with it.
  const [picked, setPicked] = useState<{ rating: Rating } | null>(null);
  const rating = picked ? picked.rating : run.rating;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const usage = usageLine(run);
  const completed = run.timeline.status === "completed";

  useEffect(() => setPicked(null), [run.rating]);
  // A reply that leaves the screen stops being read, since its stop button goes with it.
  useEffect(
    () => () => {
      if (readingNow() === run.id) stopReading();
    },
    [run.id],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });

  function rate(next: Rating) {
    const before = rating;
    setPicked({ rating: next });
    setProblem(null);
    void Haptics.selectionAsync();
    void safe(api.runs.rate({ runId: run.id, rating: next })).then(async (result) => {
      if (!result.error) return refresh();
      setPicked({ rating: before });
      setProblem(errorMessage(result.error, "Couldn't save that."));
    });
  }

  return (
    <View style={{ gap: space(1) }}>
      <View style={styles.row} testID="run-actions">
        {reply ? (
          <>
            <IconButton
              icon={copied ? Check : Copy}
              label={copied ? "Copied" : "Copy reply"}
              onPress={async () => {
                await Clipboard.setStringAsync(reply);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              testID="copy-reply"
            />
            <IconButton
              icon={reading ? Square : Volume2}
              label={reading ? "Stop reading" : "Read aloud"}
              active={reading}
              filled={reading}
              onPress={() => (reading ? stopReading() : readAloud(run.id, reply))}
              testID="read-aloud"
            />
          </>
        ) : null}
        {completed && (
          <>
            <IconButton
              icon={ThumbsUp}
              label="Good reply"
              active={rating === "up"}
              filled={rating === "up"}
              onPress={() => rate(rating === "up" ? null : "up")}
              testID="rate-up"
            />
            <IconButton
              icon={ThumbsDown}
              label="Bad reply"
              active={rating === "down"}
              filled={rating === "down"}
              onPress={() => {
                if (rating === "down") return rate(null);
                rate("down");
                setFeedbackOpen(true);
              }}
              testID="rate-down"
            />
          </>
        )}
        {usage && (
          <Text variant="caption" muted numberOfLines={1} style={styles.usage} testID="run-usage">
            {usage}
          </Text>
        )}
      </View>
      {problem && (
        <Text variant="small" style={{ color: colors.destructive }}>
          {problem}
        </Text>
      )}
      {note && (
        <Text variant="small" muted testID="feedback-saved">
          {note}
        </Text>
      )}
      <FeedbackSheet
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        runId={run.id}
        botName={botName}
        onSent={(remembered) => {
          void refresh();
          if (remembered) {
            setNote(`${botName} will remember that before every task.`);
            setTimeout(() => setNote(null), 5000);
          }
        }}
      />
    </View>
  );
}

/**
 * What the teammate should do differently. They can keep it as a lesson they read before every
 * task, and try again right away.
 */
function FeedbackSheet({
  open,
  onClose,
  runId,
  botName,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  runId: string;
  botName: string;
  onSent: (remembered: boolean) => void;
}) {
  const colors = useColors();
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(true);
  const [sending, setSending] = useState<"redo" | "save" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per "Try again with this", so sending it again after a lost answer asks only once.
  const redo = useRef<{ key: string; clientId: string } | null>(null);
  const field = useRef<TextInputInstance>(null);
  const canSend = text.trim().length > 0 && text.length <= MAX_LESSON_CHARS && sending === null;

  async function send(again: boolean) {
    if (!canSend) return;
    const key = JSON.stringify([text.trim(), remember]);
    if (again && redo.current?.key !== key) redo.current = { key, clientId: Crypto.randomUUID() };
    setSending(again ? "redo" : "save");
    setProblem(null);
    const result = await safe(
      api.runs.feedback({
        runId,
        text: text.trim(),
        remember,
        redo: again ? { clientId: redo.current!.clientId } : null,
      }),
    );
    setSending(null);
    if (result.error) {
      setProblem(errorMessage(result.error, "Couldn't send your feedback."));
      return;
    }
    redo.current = null;
    setText("");
    onSent(remember);
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`What should ${botName} do differently?`}
      focusOnShow={field}
      testID="feedback-sheet"
    >
      <View style={styles.form}>
        <TextField
          ref={field}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={MAX_LESSON_CHARS}
          placeholder="Keep it to a few bullets, and link your sources."
          testID="feedback-text"
        />
        <Pressable
          onPress={() => setRemember((value) => !value)}
          style={styles.switchRow}
          accessibilityRole="switch"
          accessibilityState={{ checked: remember }}
        >
          <Text variant="small" muted style={{ flex: 1 }}>
            Remember this for future tasks
          </Text>
          <Switch
            value={remember}
            onValueChange={setRemember}
            trackColor={{ false: colors.input, true: colors.primary }}
            thumbColor={colors.surface}
          />
        </Pressable>
        {problem && (
          <Text variant="small" style={{ color: colors.destructive }}>
            {problem}
          </Text>
        )}
        <View style={styles.buttons}>
          {remember && (
            <Button
              title="Just save"
              variant="outline"
              disabled={!canSend}
              busy={sending === "save"}
              onPress={() => void send(false)}
              style={{ flex: 1 }}
            />
          )}
          <Button
            title="Try again with this"
            disabled={!canSend}
            busy={sending === "redo"}
            onPress={() => void send(true)}
            style={{ flex: 1.4 }}
            testID="feedback-redo"
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginLeft: -space(2), minHeight: 32 },
  icon: { width: 34, height: 32, alignItems: "center", justifyContent: "center" },
  usage: {
    marginLeft: "auto",
    paddingLeft: space(2),
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    minHeight: 28,
    alignSelf: "flex-start",
  },
  form: { paddingHorizontal: space(5), gap: space(3) },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space(3), minHeight: 36 },
  buttons: { flexDirection: "row", gap: space(2) },
});
