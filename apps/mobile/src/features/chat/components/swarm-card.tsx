import { plainText, type SwarmItem, type SwarmTaskState } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { router } from "expo-router";
import { Check, ChevronRight, Clock, Network, Square, X } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { radius, space, useColors } from "@/theme";

const LABEL: Record<SwarmTaskState, string> = {
  queued: "Waiting to start",
  running: "Working",
  completed: "Done",
  failed: "Couldn't finish",
  stopped: "Stopped",
};

function StateIcon({ state }: { state: SwarmTaskState }) {
  const colors = useColors();
  switch (state) {
    case "queued":
      return <Clock size={14} color={colors.mutedForeground} />;
    case "running":
      return <View style={[styles.live, { backgroundColor: colors.working }]} />;
    case "completed":
      return <Check size={14} color={colors.done} />;
    case "failed":
      return <X size={14} color={colors.destructive} />;
    case "stopped":
      return <Square size={11} color={colors.mutedForeground} />;
  }
}

/** A job split across helpers working at once: how far along it is, and a way to stop it. */
export function SwarmCard({ item, botName }: { item: SwarmItem; botName: string }) {
  const colors = useColors();
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const total = item.tasks.length;
  const done = item.tasks.filter((task) =>
    ["completed", "failed", "stopped"].includes(task.state),
  ).length;
  const running = item.state === "running";

  const stop = () =>
    Alert.alert(
      "Stop the swarm?",
      `Every helper stops now, and ${botName} won't get their results. What they finished stays in their chats.`,
      [
        { text: "Keep going", style: "cancel" },
        {
          text: "Stop helpers",
          style: "destructive",
          onPress: async () => {
            setStopping(true);
            setProblem(null);
            const result = await safe(api.swarms.stop({ swarmId: item.swarmId }));
            setStopping(false);
            if (result.error) setProblem(errorMessage(result.error));
          },
        },
      ],
    );

  return (
    <View
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="swarm"
    >
      <View style={styles.head}>
        <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
          <Network size={16} color={colors.mutedForeground} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label">{item.title}</Text>
          <Text variant="caption" muted>
            {running
              ? `${total} helpers at once · ${done} of ${total} done`
              : item.state === "stopped"
                ? `You stopped it · ${done} of ${total} finished`
                : `${total} helpers finished · ${botName} merged their results`}
          </Text>
        </View>
        {running &&
          (stopping ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Pressable
              onPress={stop}
              accessibilityRole="button"
              style={[styles.stop, { borderColor: colors.input }]}
              hitSlop={6}
              testID="stop-swarm"
            >
              <Square size={10} color={colors.foreground} fill={colors.foreground} />
              <Text variant="small">Stop</Text>
            </Pressable>
          ))}
      </View>
      <View style={[styles.bar, { backgroundColor: colors.muted }]}>
        <View
          style={{
            width: `${total ? (done / total) * 100 : 0}%`,
            height: "100%",
            borderRadius: 2,
            backgroundColor: item.state === "stopped" ? colors.mutedForeground : colors.done,
          }}
        />
      </View>
      {item.tasks.map((task) => (
        <Pressable
          key={task.id}
          disabled={!task.chatId}
          onPress={() => task.chatId && router.push(`/chats/${task.chatId}`)}
          style={styles.task}
          accessibilityRole="button"
        >
          <View style={styles.taskIcon}>
            <StateIcon state={task.state} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="small" numberOfLines={1} style={{ fontSize: 14 }}>
              {task.title}
            </Text>
            <Text variant="caption" muted numberOfLines={1}>
              {task.result ? plainText(task.result) : LABEL[task.state]}
            </Text>
          </View>
          {task.chatId && <ChevronRight size={16} color={colors.mutedForeground} />}
        </Pressable>
      ))}
      {problem && (
        <Text variant="small" style={{ color: colors.destructive }}>
          {problem}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(3) },
  head: { flexDirection: "row", alignItems: "center", gap: space(3) },
  mark: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(2.5),
    minHeight: 32,
  },
  bar: { height: 4, borderRadius: 2, overflow: "hidden" },
  task: { flexDirection: "row", alignItems: "center", gap: space(2.5), minHeight: 36 },
  taskIcon: { width: 16, alignItems: "center" },
  live: { width: 7, height: 7, borderRadius: 3.5 },
});
