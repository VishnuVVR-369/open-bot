import type { BotSummary, RunView } from "@open-bot/api";
import { isNothingToReport, isRunActive, shellScript, type TimelineItem } from "@open-bot/shared";
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarClock,
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
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Markdown } from "@/components/markdown";
import { Text } from "@/components/text";
import { diffStats } from "@/lib/format";
import { clock, elapsed } from "@/lib/time";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { ApprovalCard } from "./approval-card";
import { CodeBlock, Step, type StepIcon } from "./step";

/** Items that stay visible when the steps are collapsed. */
function isPinned(item: TimelineItem): boolean {
  return (
    (item.kind === "message" && item.phase === "final") ||
    item.kind === "user_message" ||
    item.kind === "error" ||
    item.kind === "swarm" ||
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
  return (
    <Text variant="mono" muted style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>
      {elapsed(now - new Date(since).getTime())}
    </Text>
  );
}

function WorkingLine({ run }: { run: RunView }) {
  const colors = useColors();
  const { status, waitingFor } = run.timeline;
  if (status === "waiting") {
    return (
      <View style={styles.working}>
        <View style={[styles.dot, { backgroundColor: colors.waiting }]} />
        <Text variant="small" style={{ color: colors.waiting }}>
          {waitingFor === "takeover" ? "Waiting for you to take over" : "Waiting for your approval"}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.working} testID="working">
      <View
        style={[
          styles.dot,
          {
            backgroundColor:
              status === "queued"
                ? mix(colors.mutedForeground, colors.background, 0.5)
                : colors.live,
          },
        ]}
      />
      <Text variant="small" muted>
        {status === "queued" ? "Up next" : status === "starting" ? "Getting ready" : "Working"}
      </Text>
      {status !== "queued" && <Elapsed since={run.createdAt} />}
    </View>
  );
}

function ItemView({
  item,
  chatId,
  botName,
}: {
  item: TimelineItem;
  chatId: string;
  botName: string;
}): ReactNode {
  const colors = useColors();
  switch (item.kind) {
    case "message":
      return item.phase === "final" ? (
        <Markdown text={item.text} />
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
          <Text variant="caption" muted style={styles.overline}>
            PLAN
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
      return <ApprovalCard item={item} chatId={chatId} />;
    case "takeover_request":
      return (
        <View
          style={[
            styles.card,
            {
              borderColor: mix(colors.manual, colors.surface, 0.4),
              backgroundColor: mix(colors.manual, colors.surface, 0.08),
            },
          ]}
        >
          <View style={styles.row}>
            <Hand size={16} color={colors.manualInk} />
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
            <Text variant="caption" muted>
              Take over from open-bot on a computer.
            </Text>
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
            style={[styles.pill, { backgroundColor: mix(colors.manual, colors.background, 0.12) }]}
          >
            <Undo2 size={14} color={colors.manualInk} />
            <Text variant="small" style={{ color: colors.manualInk }}>
              {item.text
                ? `You handed the screen back: “${item.text}”`
                : "You handed the screen back"}
            </Text>
          </View>
        );
      return (
        <View style={styles.steered}>
          <View style={[styles.steeredBubble, { backgroundColor: colors.subtle }]}>
            <Text style={{ fontSize: 14.5 }} selectable>
              {item.text}
            </Text>
          </View>
        </View>
      );
    case "swarm":
      return (
        <View
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <View style={styles.row}>
            <Network size={16} color={colors.mutedForeground} />
            <Text variant="label" style={{ flex: 1 }}>
              {item.title}
            </Text>
          </View>
          {item.tasks.map((task) => (
            <View key={task.id} style={styles.row}>
              {task.state === "running" ? (
                <ActivityIndicator size={12} color={colors.foreground} />
              ) : task.state === "completed" ? (
                <CircleCheck size={14} color={colors.done} />
              ) : task.state === "failed" ? (
                <AlertTriangle size={14} color={colors.destructive} />
              ) : (
                <CircleDashed size={14} color={colors.mutedForeground} />
              )}
              <Text variant="small" style={{ flex: 1 }} numberOfLines={1}>
                {task.title}
              </Text>
            </View>
          ))}
        </View>
      );
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

/** A teammate's turn: who, when, what they did (folded once done), and their reply. */
export const RunBlock = memo(function RunBlock({
  run,
  chatId,
  bot,
  bots,
}: {
  run: RunView;
  chatId: string;
  bot: BotSummary | undefined;
  bots: BotSummary[];
}) {
  const colors = useColors();
  const active = isRunActive(run.timeline.status);
  const items = run.timeline.items;
  const segments = useMemo(() => parts(items), [items]);
  const stepCount = segments.filter(
    (part) => part.kind === "computer" || !isPinned(part.item),
  ).length;
  const collapsible = !active && stepCount > 3;
  const [expanded, setExpanded] = useState(false);
  const showSteps = !collapsible || expanded;
  const name = bot?.name ?? "Former teammate";
  const trigger = triggerLabel(run, bots);
  const reply = items
    .filter((item) => item.kind === "message")
    .map((item) => item.text.trim())
    .join("\n\n");

  if (!active && run.trigger === "schedule" && isNothingToReport(reply)) {
    return (
      <View style={styles.quiet} testID="run">
        <BotAvatar name={name} color={bot?.color ?? "#888888"} emoji={bot?.emoji} size="sm" />
        <Text variant="small" muted style={{ flex: 1 }} numberOfLines={1}>
          <Text variant="small" style={{ fontWeight: "500" }}>
            {name}
          </Text>
          {"  "}
          {trigger?.text} · Nothing to report · {clock(run.createdAt)}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.run} testID="run">
      <View style={styles.header}>
        <BotAvatar name={name} color={bot?.color ?? "#888888"} emoji={bot?.emoji} size="sm" />
        <Text variant="heading" style={{ fontSize: 15 }} numberOfLines={1}>
          {name}
        </Text>
        {trigger && (
          <View style={[styles.row, { flexShrink: 1, gap: space(1) }]}>
            <trigger.icon size={13} color={colors.mutedForeground} />
            <Text variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
              {trigger.text}
            </Text>
          </View>
        )}
        <Text variant="caption" muted style={{ marginLeft: "auto" }}>
          {clock(run.createdAt)}
        </Text>
      </View>

      <View style={styles.body}>
        {collapsible && (
          <Pressable
            onPress={() => setExpanded((value) => !value)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            style={styles.toggle}
            hitSlop={6}
          >
            <ChevronDown
              size={14}
              color={colors.mutedForeground}
              style={{ transform: [{ rotate: expanded ? "0deg" : "-90deg" }] }}
            />
            <Text variant="small" muted>
              {expanded ? "Hide" : "Show"} {stepCount} {stepCount === 1 ? "step" : "steps"}
            </Text>
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
            "message",
            "approval",
            "takeover_request",
            "plan",
            "swarm",
            "user_message",
          ].includes(part.item.kind);
          return (
            <View key={part.id} style={spaced && styles.spaced}>
              <ItemView item={part.item} chatId={chatId} botName={name} />
            </View>
          );
        })}
        {active && <WorkingLine run={run} />}
        {run.timeline.status === "interrupted" && (
          <View style={styles.row}>
            <Square size={12} color={colors.mutedForeground} />
            <Text variant="small" muted>
              {run.timeline.error ?? `You stopped ${name}.`}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  run: { gap: space(2) },
  header: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 28 },
  body: { gap: space(1), paddingLeft: 0 },
  quiet: { flexDirection: "row", alignItems: "center", gap: space(2.5) },
  row: { flexDirection: "row", alignItems: "center", gap: space(2) },
  toggle: { flexDirection: "row", alignItems: "center", gap: space(1.5), minHeight: 28 },
  spaced: { marginVertical: space(1) },
  working: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 24 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(2) },
  overline: { letterSpacing: 0.6, fontWeight: "500" },
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
  error: {
    flexDirection: "row",
    gap: space(2),
    borderRadius: radius.lg,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
  },
});
