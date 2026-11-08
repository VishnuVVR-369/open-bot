import type { BotSummary, RunView } from "@open-bot/api";
import {
  isNothingToReport,
  isRunActive,
  shellScript,
  splitComputerPaths,
  type TimelineItem,
} from "@open-bot/domain";
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  Eye,
  FilePen,
  Hand,
  ListTodo,
  Mail,
  MessageCircleQuestion,
  MessageCircleReply,
  Monitor,
  Network,
  Search,
  ShieldCheck,
  Square,
  SquareTerminal,
  Undo2,
  Webhook,
  Wrench,
} from "lucide-react-native";
import { router } from "expo-router";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { BotAvatar, needsYouText } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { FoldableText } from "@/components/chat/foldable-text";
import { Markdown } from "@/components/markdown";
import { Text } from "@/components/text";
import { diffStats } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { phoneClock } from "@/lib/phone-clock";
import { screenHref } from "@/lib/screens";
import { elapsed } from "@/lib/time";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { FileChip } from "@/components/file-chip";
import { ApprovalCard } from "./approval-card";
import { RetryRun, RunActions } from "./run-actions";
import { CodeBlock, Step, type StepIcon } from "./step";
import { PageCard } from "./page-card";
import { SwarmCard } from "./swarm-card";

/** Items that stay visible when the steps are collapsed. */
function isPinned(item: TimelineItem): boolean {
  return (
    (item.kind === "message" && item.phase === "final") ||
    item.kind === "user_message" ||
    item.kind === "error" ||
    item.kind === "swarm" ||
    item.kind === "page" ||
    (item.kind === "approval" && item.decision === "pending") ||
    (item.kind === "takeover_request" &&
      (item.resolution === "pending" || item.resolution === "taken"))
  );
}

type Part =
  | { kind: "computer"; id: string; count: number; running: boolean }
  | { kind: "item"; id: string; item: TimelineItem };

/** Computer actions in a row become one step: the phone doesn't show the screen yet. */
function parts(items: TimelineItem[]): Part[] {
  const result: Part[] = [];
  for (const item of items) {
    const last = result.at(-1);
    if (item.kind === "computer") {
      if (last?.kind === "computer") {
        last.count += 1;
        last.running = item.status === "running";
      } else
        result.push({
          kind: "computer",
          id: item.id,
          count: 1,
          running: item.status === "running",
        });
    } else result.push({ kind: "item", id: item.id, item });
  }
  return result;
}

function triggerLabel(run: RunView, bots: BotSummary[]): { icon: StepIcon; text: string } | null {
  const from = bots.find((bot) => bot.id === run.fromBotId)?.name;
  switch (run.trigger) {
    case "schedule":
      return { icon: CalendarClock, text: run.scheduleTitle ?? "Scheduled task" };
    case "watch":
      return { icon: Eye, text: run.triggerTitle ?? "Page watch" };
    case "webhook":
      return { icon: Webhook, text: run.triggerTitle ?? "Webhook" };
    case "gmail":
      return { icon: Mail, text: run.triggerTitle ?? "New mail" };
    case "calendar":
      return { icon: CalendarDays, text: run.triggerTitle ?? "Calendar event" };
    case "hand_back":
      return { icon: Undo2, text: "After you handed back" };
    case "approval":
      return { icon: ShieldCheck, text: "After your decision" };
    case "handoff":
      return { icon: ArrowRightLeft, text: from ? `From ${from}` : "Handed over" };
    case "question":
      return { icon: MessageCircleQuestion, text: from ? `${from} asked` : "A teammate asked" };
    case "answer":
      return { icon: MessageCircleReply, text: from ? `${from} answered` : "A teammate answered" };
    case "task":
      return { icon: ListTodo, text: "From the task board" };
    case "email":
      return { icon: Mail, text: "An email" };
    case "swarm":
      return { icon: Network, text: "Swarm helper" };
    case "swarm_results":
      return { icon: Network, text: "With the helpers' results" };
    default:
      return null;
  }
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ms = now - new Date(since).getTime();
  // A quick reply doesn't need a stopwatch.
  if (ms < 10_000) return null;
  return (
    <Text
      variant="mono"
      muted
      style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {elapsed(ms)}
    </Text>
  );
}

/** What the teammate is doing right now, in a few words, from their latest step. */
function currentActivity(items: TimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    switch (item.kind) {
      case "command":
        return `Running ${shellScript(item.command).split("\n")[0]}`;
      case "file_change":
        return `Editing ${item.changes.map((c) => c.path.split("/").pop()).join(", ")}`;
      case "web_search":
        return item.query ? `Searching for “${item.query}”` : "Searching the web";
      case "computer":
        return "Using the computer";
      case "tool":
        return item.label;
      case "reasoning":
        return "Thinking";
      case "message":
        if (item.phase !== "final") return null;
        return "Writing";
      default:
        continue;
    }
  }
  return null;
}

function WorkingLine({ run }: { run: RunView }) {
  const colors = useColors();
  const { status, waitingFor } = run.timeline;
  if (status === "waiting") {
    return (
      <View style={styles.working} accessibilityLiveRegion="polite">
        <View style={[styles.dot, { backgroundColor: colors.attention }]} />
        <Text variant="small" style={{ color: colors.attentionInk, fontWeight: "500" }}>
          {needsYouText(waitingFor)}
        </Text>
      </View>
    );
  }
  const doing = status === "running" ? currentActivity(run.timeline.items) : null;
  return (
    <View style={styles.working} testID="working" accessibilityLiveRegion="polite">
      {status === "queued" ? (
        <View
          style={[
            styles.dot,
            { backgroundColor: mix(colors.mutedForeground, colors.background, 0.5) },
          ]}
        />
      ) : (
        <ActivityIndicator size={14} color={colors.working} />
      )}
      <Text
        variant="small"
        numberOfLines={1}
        style={{ flexShrink: 1, color: colors.mutedForeground }}
      >
        {status === "queued"
          ? "Up next"
          : status === "starting"
            ? "Getting ready…"
            : `${doing ?? "Working"}…`}
      </Text>
      {status !== "queued" && <Elapsed since={run.createdAt} />}
    </View>
  );
}

function ItemView({
  botId,
  item,
  chatId,
  botName,
}: {
  botId: string;
  item: TimelineItem;
  chatId: string;
  botName: string;
}): ReactNode {
  const colors = useColors();
  switch (item.kind) {
    case "message":
      return item.phase === "final" ? (
        <View style={{ gap: space(2) }}>
          <Markdown text={item.text} />
          <MentionedFiles text={item.text} />
        </View>
      ) : (
        <Markdown text={item.text} tone="muted" />
      );
    case "reasoning": {
      if (!item.text) return null;
      const first = item.text
        .split("\n")
        .find((line) => line.trim())
        ?.replace(/\*\*/g, "");
      return (
        <Step
          icon={CircleDashed}
          running={item.status === "running"}
          summary={first ?? "Thinking"}
          detail={item.text.includes("\n") ? <Markdown text={item.text} tone="muted" /> : undefined}
        />
      );
    }
    case "command": {
      const command = shellScript(item.command);
      const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
      return (
        <Step
          icon={SquareTerminal}
          mono
          running={item.status === "running"}
          failed={failed && item.status !== "running"}
          summary={failed && item.exitCode !== null ? `${command}  exit ${item.exitCode}` : command}
          detail={<CodeBlock>{`$ ${command}\n${item.output.trim() || "(no output)"}`}</CodeBlock>}
        />
      );
    }
    case "file_change": {
      const name = (path: string) => path.split("/").slice(-2).join("/");
      const verb = item.changes.every((c) => c.change === "add")
        ? "Created"
        : item.changes.every((c) => c.change === "delete")
          ? "Deleted"
          : "Edited";
      const only = item.changes.length === 1 ? item.changes[0] : undefined;
      const stats = only?.diff ? diffStats(only.diff) : null;
      return (
        <Step
          icon={FilePen}
          running={item.status === "running"}
          failed={item.status === "failed"}
          summary={`${verb} ${item.changes.map((c) => name(c.path)).join(", ")}${
            stats ? `  +${stats.added} −${stats.removed}` : ""
          }`}
          detail={
            <View style={{ gap: space(2) }}>
              {item.changes.map((change) => (
                <CodeBlock key={change.path}>{`${change.path}\n${change.diff}`}</CodeBlock>
              ))}
            </View>
          }
        />
      );
    }
    case "tool":
      return (
        <Step
          icon={Wrench}
          running={item.status === "running"}
          failed={item.status === "failed"}
          summary={[item.label, item.result, item.status === "failed" ? item.error : undefined]
            .filter(Boolean)
            .join(" · ")}
        />
      );
    case "web_search":
      return (
        <Step
          icon={Search}
          running={item.status === "running"}
          summary={item.query ? `Searched the web for “${item.query}”` : "Searched the web"}
        />
      );
    case "plan":
      return (
        <View
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text variant="overline" muted>
            Plan
          </Text>
          {item.steps.map((step, index) => (
            <View key={index} style={styles.planStep}>
              <View style={styles.planMark}>
                {step.status === "completed" ? (
                  <CircleCheck size={16} color={colors.done} />
                ) : step.status === "inProgress" ? (
                  <ActivityIndicator size={12} color={colors.foreground} />
                ) : (
                  <View style={[styles.planPending, { borderColor: colors.mutedForeground }]} />
                )}
              </View>
              <Text
                variant="small"
                muted={step.status === "completed"}
                style={[
                  { flex: 1, fontSize: 14 },
                  step.status === "completed" && { textDecorationLine: "line-through" },
                ]}
              >
                {step.step}
              </Text>
            </View>
          ))}
        </View>
      );
    case "approval":
      return <ApprovalCard item={item} chatId={chatId} botName={botName} />;
    case "takeover_request":
      return (
        <View
          style={[
            styles.card,
            {
              borderColor: mix(colors.attention, colors.surface, 0.4),
              backgroundColor: mix(colors.attention, colors.surface, 0.08),
            },
          ]}
        >
          <View style={styles.row}>
            <Hand size={16} color={colors.attentionInk} />
            <Text variant="label" style={{ flex: 1 }}>
              {item.resolution === "pending"
                ? `${botName} needs you to take over`
                : item.resolution === "taken"
                  ? "You're in control of the screen"
                  : item.resolution === "handed_back"
                    ? "You handed the screen back"
                    : "Dismissed"}
            </Text>
          </View>
          <Text variant="small" muted>
            {item.reason}
          </Text>
          {item.resolution === "pending" && (
            <Button
              title="Open the screen"
              onPress={() => router.push(screenHref(botId, item.takeoverRequestId))}
            />
          )}
        </View>
      );
    case "handoff":
      return (
        <Step icon={ArrowRightLeft} summary={`Handed to ${item.toBotName}: ${item.message}`} />
      );
    case "user_message":
      if (item.variant === "hand_back")
        return (
          <View
            style={[
              styles.pill,
              { backgroundColor: mix(colors.attention, colors.background, 0.12) },
            ]}
          >
            <Undo2 size={14} color={colors.attentionInk} />
            <Text variant="small" style={{ color: colors.attentionInk }}>
              {item.text
                ? `You handed the screen back: “${item.text}”`
                : "You handed the screen back"}
            </Text>
          </View>
        );
      return (
        <View style={styles.steered}>
          <View style={[styles.steeredBubble, { backgroundColor: colors.subtle }]}>
            <FoldableText
              text={item.text}
              style={{ color: colors.foreground, fontSize: 14.5, lineHeight: 22 }}
              background={colors.subtle}
              foreground={colors.foreground}
            />
          </View>
        </View>
      );
    case "swarm":
      return <SwarmCard item={item} botName={botName} />;
    case "page":
      return <PageCard item={item} />;
    case "error":
      return (
        <View
          style={[
            styles.error,
            { backgroundColor: mix(colors.destructive, colors.background, 0.08) },
          ]}
        >
          <AlertTriangle size={16} color={colors.destructive} style={{ marginTop: 2 }} />
          <Text variant="small" style={{ color: colors.destructive, flex: 1, fontSize: 14 }}>
            {item.message}
          </Text>
        </View>
      );
    case "computer":
      return null;
  }
}

/** Files on the computer a reply mentions, as chips that open them. */
function MentionedFiles({ text }: { text: string }) {
  const paths = useMemo(
    () => [
      ...new Set(
        splitComputerPaths(text)
          .filter((part) => part.path)
          .map((part) => part.text),
      ),
    ],
    [text],
  );
  if (paths.length === 0) return null;
  return (
    <View style={styles.files}>
      {paths.map((path) => (
        <FileChip key={path} path={path} />
      ))}
    </View>
  );
}

/**
 * How long the teammate worked, like "21s" or "2m 05s": until the run finished, or until it
 * stopped to wait on you. Null while it's still working.
 */
function took(run: RunView): string | null {
  if (!run.startedAt) return null;
  const pending = run.timeline.items.find(
    (item) =>
      (item.kind === "approval" && item.decision === "pending") ||
      (item.kind === "takeover_request" && item.resolution === "pending"),
  );
  const end =
    run.completedAt ?? (run.timeline.status === "waiting" ? pending?.startedAt : undefined);
  if (!end) return null;
  return elapsed(Math.max(0, new Date(end).getTime() - new Date(run.startedAt).getTime()));
}

/** The steps toggle's words: "Worked for 8s · 2 steps", the same on every turn. */
export function workSummary(duration: string | null, steps: number): string {
  const count = `${steps} ${steps === 1 ? "step" : "steps"}`;
  return duration ? `Worked for ${duration} · ${count}` : count;
}

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
  const segments = useMemo(() => parts(items), [items]);
  const stepCount = segments.filter(
    (part) => part.kind === "computer" || !isPinned(part.item),
  ).length;
  const failed = run.timeline.status === "failed";
  // A turn that's still working shows its steps; a finished one (or one waiting on you) folds
  // them into one line, until you open it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? (active && run.timeline.status !== "waiting");
  const [menuOpen, setMenuOpen] = useState(false);
  const showSteps = expanded || stepCount === 0;
  const name = bot?.name ?? "Former teammate";
  const trigger = triggerLabel(run, bots);
  const reply = items
    .flatMap((item) =>
      item.kind === "message" && item.phase === "final" ? [item.text.trim()] : [],
    )
    .join("\n\n");
  const finished = !active && (reply || run.timeline.status === "completed");
  // A pending approval or takeover card already says what they're waiting for.
  const waitingOnCard =
    run.timeline.status === "waiting" &&
    items.some(
      (item) =>
        (item.kind === "approval" && item.decision === "pending") ||
        (item.kind === "takeover_request" && item.resolution === "pending"),
    );
  const duration = took(run);

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
              <trigger.icon size={13} color={colors.mutedForeground} />
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
        {segments.map((part) => {
          if (part.kind === "computer") {
            if (!showSteps) return null;
            return (
              <Step
                key={part.id}
                icon={Monitor}
                running={part.running && active}
                summary={`Used the computer · ${part.count} ${part.count === 1 ? "action" : "actions"}`}
              />
            );
          }
          if (!showSteps && !isPinned(part.item)) return null;
          const spaced = [
            "approval",
            "takeover_request",
            "plan",
            "swarm",
            "page",
            "user_message",
          ].includes(part.item.kind);
          return (
            <View key={part.id} style={spaced && styles.spaced}>
              <ItemView botId={run.botId} item={part.item} chatId={chatId} botName={name} />
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
  working: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 24 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(2) },
  planStep: { flexDirection: "row", alignItems: "flex-start", gap: space(2.5) },
  planMark: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  planPending: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, opacity: 0.6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    alignSelf: "flex-start",
    borderRadius: radius.full,
    paddingHorizontal: space(3),
    paddingVertical: space(1),
  },
  steered: { flexDirection: "row", justifyContent: "flex-end" },
  steeredBubble: {
    maxWidth: "85%",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2),
  },
  files: { flexDirection: "row", flexWrap: "wrap", gap: space(1.5) },
  error: {
    flexDirection: "row",
    gap: space(2),
    borderRadius: radius.lg,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
  },
});
