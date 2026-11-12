import type { RunView } from "@open-bot/api";
import { sendAttempt, type SendAttempt } from "@open-bot/chat-core";
import { compactNumber, formatDollars, formatDuration, MAX_LESSON_CHARS } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import {
  Check,
  Copy,
  Ellipsis,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type TextInputInstance } from "react-native";
import { Button } from "@/components/button";
import { Sheet, SheetItem } from "@/components/sheet";
import { Toggle } from "@/components/toggle";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { phoneDayClock } from "@/lib/phone-clock";
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
      android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
      style={styles.icon}
      testID={testID}
    >
      <Icon size={18} color={color} fill={filled ? color : "transparent"} />
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
 * What you can do with a finished reply: copy it, hear it, rate it (a thumbs down asks what to
 * change), and see what it took. The newest reply shows them in a row under it; every reply has
 * them in a sheet (`menuOpen`), which a long press on the reply opens.
 */
export function RunActions({
  run,
  chatId,
  botName,
  reply,
  showRow,
  menuOpen,
  onMenuChange,
}: {
  run: RunView;
  chatId: string;
  botName: string;
  reply: string;
  showRow: boolean;
  menuOpen: boolean;
  onMenuChange: (open: boolean) => void;
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
    haptics.tap();
    void safe(api.runs.rate({ runId: run.id, rating: next })).then(async (result) => {
      if (!result.error) return refresh();
      setPicked({ rating: before });
      setProblem(errorMessage(result.error, "Couldn't save that."));
    });
  }
  async function copy() {
    await Clipboard.setStringAsync(reply);
    haptics.success();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const toggleReading = () => (reading ? stopReading() : readAloud(run.id, reply));
  const rateUp = () => rate(rating === "up" ? null : "up");
  const rateDown = () => {
    if (rating === "down") return rate(null);
    rate("down");
    setFeedbackOpen(true);
  };
  const close = (then?: () => void) => {
    onMenuChange(false);
    then?.();
  };

  const visible = showRow || Boolean(problem) || Boolean(note);
  return (
    <>
      {visible && (
        <View style={{ gap: space(1) }}>
          {showRow && (
            <View style={styles.row} testID="run-actions">
              {reply ? (
                <>
                  <IconButton
                    icon={copied ? Check : Copy}
                    label={copied ? "Copied" : "Copy reply"}
                    onPress={() => void copy()}
                    testID="copy-reply"
                  />
                  <IconButton
                    icon={reading ? Square : Volume2}
                    label={reading ? "Stop reading" : "Read aloud"}
                    active={reading}
                    filled={reading}
                    onPress={toggleReading}
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
                    onPress={rateUp}
                    testID="rate-up"
                  />
                  <IconButton
                    icon={ThumbsDown}
                    label="Bad reply"
                    active={rating === "down"}
                    filled={rating === "down"}
                    onPress={rateDown}
                    testID="rate-down"
                  />
                </>
              )}
              <IconButton
                icon={Ellipsis}
                label="More"
                onPress={() => onMenuChange(true)}
                testID="reply-more"
              />
            </View>
          )}
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
        </View>
      )}
      {/* The sheets open in their own window; out of the layout, they add no space to the turn. */}
      <View style={styles.sheets}>
        <Sheet
          open={menuOpen}
          onClose={() => onMenuChange(false)}
          title={`${botName}'s reply`}
          description={[phoneDayClock(run.createdAt), usage].filter(Boolean).join(" · ")}
          testID="reply-menu"
        >
          {reply ? (
            <>
              <SheetItem
                icon={<Copy size={20} color={colors.foreground} />}
                label="Copy"
                onPress={() => close(() => void copy())}
              />
              <SheetItem
                icon={
                  reading ? (
                    <Square size={20} color={colors.foreground} />
                  ) : (
                    <Volume2 size={20} color={colors.foreground} />
                  )
                }
                label={reading ? "Stop reading" : "Read aloud"}
                onPress={() => close(toggleReading)}
              />
            </>
          ) : null}
          {completed && (
            <>
              <SheetItem
                icon={
                  <ThumbsUp
                    size={20}
                    color={colors.foreground}
                    fill={rating === "up" ? colors.foreground : "transparent"}
                  />
                }
                label={rating === "up" ? "Rated good" : "Good reply"}
                onPress={() => close(rateUp)}
              />
              <SheetItem
                icon={
                  <ThumbsDown
                    size={20}
                    color={colors.foreground}
                    fill={rating === "down" ? colors.foreground : "transparent"}
                  />
                }
                label={rating === "down" ? "Rated bad" : "Bad reply, tell them why"}
                onPress={() => close(rateDown)}
              />
            </>
          )}
          {usage && (
            <Text variant="caption" muted style={styles.usage} testID="run-usage">
              {usage}
            </Text>
          )}
        </Sheet>
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
    </>
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
  const redo = useRef<SendAttempt | null>(null);
  const field = useRef<TextInputInstance>(null);
  const canSend = text.trim().length > 0 && text.length <= MAX_LESSON_CHARS && sending === null;

  async function send(again: boolean) {
    if (!canSend) return;
    if (again) redo.current = sendAttempt(redo.current, [text.trim(), remember], Crypto.randomUUID);
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
          <Toggle value={remember} onValueChange={setRemember} />
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
  sheets: { position: "absolute", width: 0, height: 0 },
  row: { flexDirection: "row", alignItems: "center", marginLeft: -space(3), minHeight: 44 },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  usage: { paddingHorizontal: space(5), paddingTop: space(2), fontVariant: ["tabular-nums"] },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    minHeight: 40,
    alignSelf: "flex-start",
  },
  form: { paddingHorizontal: space(5), gap: space(3) },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space(3), minHeight: 36 },
  buttons: { flexDirection: "row", gap: space(2) },
});
