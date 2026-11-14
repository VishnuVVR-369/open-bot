import type { BotSummary, RunView } from "@open-bot/api";
import {
  isPinned,
  pendingRequest,
  plural,
  replyText,
  triggerLabel,
  turnParts,
  workDuration,
  workSummary,
  type TriggerKind,
} from "@open-bot/chat-core";
import { isNothingToReport, isRunActive } from "@open-bot/domain";
import {
  ArrowRightLeft,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  Eye,
  ListTodo,
  Mail,
  MessageCircleQuestion,
  MessageCircleReply,
  Monitor,
  Network,
  ShieldCheck,
  Square,
  Undo2,
  Webhook,
} from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { phoneClock } from "@/lib/phone-clock";
import { CARD_KINDS } from "@/features/chat/step-text";
import { space, useColors } from "@/theme";
import { RetryRun, RunActions } from "./run-actions";
import { Step, type StepIcon } from "./step";
import { TimelineItemView } from "./timeline-item";
import { WorkingLine } from "./working-line";

/** Each trigger's icon; the words come from `triggerLabel` (packages/chat-core). */
const TRIGGER_ICONS: Record<TriggerKind, StepIcon> = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
  hand_back: Undo2,
  approval: ShieldCheck,
  handoff: ArrowRightLeft,
  question: MessageCircleQuestion,
  answer: MessageCircleReply,
  task: ListTodo,
  email: Mail,
  swarm: Network,
  swarm_results: Network,
};

/**
 * A teammate's turn: what they did (folded away unless you ask, so the chat reads like a
 * conversation and not a log) and their reply. In a group, who answered heads the turn; in a
 * direct chat the header already says who it is.
 */
export const RunBlock = memo(function RunBlock({
  run,
  chatId,
  bot,
  bots,
  superseded = false,
  isGroup = false,
  latest = false,
}: {
  run: RunView;
  chatId: string;
  bot: BotSummary | undefined;
  bots: BotSummary[];
  /** The same teammate ran again after this, so there's nothing to retry. */
  superseded?: boolean;
  isGroup?: boolean;
  /** The newest turn in the chat: its reply actions show without a long press. */
  latest?: boolean;
}) {
  const colors = useColors();
  const active = isRunActive(run.timeline.status);
  const items = run.timeline.items;
  const { parts, approved, steps: stepCount } = useMemo(() => turnParts(items), [items]);
  const failed = run.timeline.status === "failed";
  // A turn that's still working shows its steps; a finished one (or one waiting on you) folds
  // them into one line, until you open it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? (active && run.timeline.status !== "waiting");
  const [menuOpen, setMenuOpen] = useState(false);
  const showSteps = expanded || stepCount === 0;
  const name = bot?.name ?? "Former teammate";
  const trigger = triggerLabel(run, bots);
  const reply = replyText(items);
  const finished = !active && (reply || run.timeline.status === "completed");
  // A pending approval or takeover card already says what they're waiting for.
  const waitingOnCard = run.timeline.status === "waiting" && Boolean(pendingRequest(items));
  const duration = workDuration(run);
  const TriggerIcon = trigger && TRIGGER_ICONS[trigger.kind];

  if (!active && run.trigger === "schedule" && isNothingToReport(reply)) {
    return (
      <View style={styles.quiet} testID="run">
        <BotAvatar name={name} color={bot?.color ?? "#888888"} emoji={bot?.emoji} size="xs" />
        <Text variant="small" muted style={{ flex: 1 }} numberOfLines={1}>
          {isGroup && (
            <Text variant="small" style={{ fontWeight: "500" }}>
              {name}
              {"  "}
            </Text>
          )}
          {trigger?.text} · Nothing to report · {phoneClock(run.createdAt)}
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      testID="run"
      style={styles.run}
      // A long press anywhere on the turn opens what you can do with its reply.
      onLongPress={
        finished
          ? () => {
              haptics.press();
              setMenuOpen(true);
            }
          : undefined
      }
      delayLongPress={350}
    >
      {(isGroup || trigger) && (
        <View style={styles.header}>
          {isGroup && (
            <>
              <BotAvatar
                name={name}
                color={bot?.color ?? "#888888"}
                emoji={bot?.emoji}
                size="sm"
                activity={
                  active ? (run.timeline.status === "waiting" ? "waiting" : "working") : "idle"
                }
              />
              <Text variant="heading" style={{ fontSize: 15, flexShrink: 1 }} numberOfLines={1}>
                {name}
              </Text>
              <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                {phoneClock(run.createdAt)}
              </Text>
            </>
          )}
          {trigger && (
            <View style={[styles.row, { flexShrink: 1, gap: space(1.5) }]}>
              {TriggerIcon && <TriggerIcon size={13} color={colors.mutedForeground} />}
              <Text variant="small" muted numberOfLines={1} style={{ flexShrink: 1 }}>
                {trigger.text}
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.body}>
        {stepCount > 0 && (
          <Pressable
            onPress={() => {
              haptics.tap();
              animateLayout();
              setToggled(!expanded);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${workSummary(duration, stepCount)}. ${expanded ? "Hide" : "Show"} the steps`}
            style={styles.toggle}
            hitSlop={{ top: 10, bottom: 10, right: 12 }}
            testID="steps-toggle"
          >
            {/* The words start on the turn's left edge, with the reply; the chevron follows them. */}
            <Text variant="small" muted>
              {workSummary(duration, stepCount)}
            </Text>
            <ChevronDown
              size={15}
              color={colors.mutedForeground}
              style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
            />
          </Pressable>
        )}
        {parts.map((part) => {
          if (part.kind === "computer") {
            if (!showSteps) return null;
            return (
              <Step
                key={part.id}
                icon={Monitor}
                running={part.items.at(-1)?.status === "running" && active}
                summary={`Used the computer · ${plural(part.items.length, "action")}`}
              />
            );
          }
          if (!showSteps && !isPinned(part.item)) return null;
          const spaced = CARD_KINDS.includes(part.item.kind);
          return (
            <View key={part.id} style={spaced && styles.spaced}>
              <TimelineItemView
                teammateId={run.botId}
                item={part.item}
                chatId={chatId}
                teammateName={name}
                approved={approved.has(part.id)}
              />
            </View>
          );
        })}
        {active && !waitingOnCard && <WorkingLine run={run} />}
        {run.timeline.status === "interrupted" && (
          <View style={styles.row}>
            <Square size={12} color={colors.mutedForeground} />
            <Text variant="small" muted>
              {run.timeline.error ?? `You stopped ${name}.`}
            </Text>
          </View>
        )}
        {!superseded && (failed || run.timeline.status === "interrupted") && (
          <RetryRun runId={run.id} chatId={chatId} />
        )}
        {finished && (
          <RunActions
            run={run}
            chatId={chatId}
            botName={name}
            reply={reply}
            showRow={latest}
            menuOpen={menuOpen}
            onMenuChange={setMenuOpen}
          />
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // Who's speaking sits about 16dp above their work, and the steps line about 12dp above the reply.
  run: { gap: space(3) },
  header: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 28 },
  body: { gap: space(2) },
  quiet: { flexDirection: "row", alignItems: "center", gap: space(2.5) },
  row: { flexDirection: "row", alignItems: "center", gap: space(2) },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    minHeight: 24,
    alignSelf: "flex-start",
  },
  // A card gets a little room after it.
  spaced: { marginBottom: space(1) },
});
