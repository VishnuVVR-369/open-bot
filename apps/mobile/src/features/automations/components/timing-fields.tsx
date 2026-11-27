import { CADENCES, parseDay, todayIn, WEEKDAYS, type ScheduleTimingForm } from "@open-bot/domain";
import { ChevronRight } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Card } from "@/components/section";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { DueSheet } from "@/features/tasks/components/due-sheet";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { reminderAt, reminderDay, reminderTime, timeLabel } from "../automations";
import { Choices } from "./automation-parts";
import { TimeSheet } from "./time-sheet";

/** "Tue, Dec 1" for a reminder's day. */
const dayLabel = (day: string) =>
  parseDay(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/**
 * When a schedule runs, as the web's dialog sets it: it repeats (every day, weekdays, a day of the
 * week, every hour, or a cron expression) at a time, or runs once on a day at a time. Times are
 * on the schedule's own clock, which the summary under it names, and so is "today" in the day
 * picker. The daily check-in always repeats, so it has no "Once".
 */
export function TimingFields({
  value,
  onChange,
  disabled,
  timeZone,
  repeatsOnly = false,
  summary,
}: {
  value: ScheduleTimingForm;
  onChange: (patch: Partial<ScheduleTimingForm>) => void;
  disabled: boolean;
  /** The schedule's own zone. */
  timeZone: string;
  /** Offers only repeating timings (the daily check-in). */
  repeatsOnly?: boolean;
  /** How it reads, and in which zone, under the fields. */
  summary: ReactNode;
}) {
  const [sheet, setSheet] = useState<"time" | "day" | null>(null);
  const open = (which: "time" | "day") => !disabled && setSheet(which);
  const hourly = value.kind === "cron" && value.cadence === "hourly";
  // A reminder's time is its own part of `at`; a routine's is `time`.
  const time = value.kind === "once" ? reminderTime(value.at) : value.time;
  const setTime = (next: string) =>
    onChange(
      value.kind === "once" ? { at: reminderAt(reminderDay(value.at), next) } : { time: next },
    );

  return (
    <View style={styles.fields}>
      {!repeatsOnly && (
        <Choices
          options={[
            { key: "cron", label: "Repeats" },
            { key: "once", label: "Once" },
          ]}
          value={value.kind}
          onChange={(kind) => onChange({ kind })}
          disabled={disabled}
          testID="timing-kind"
        />
      )}
      {value.kind === "cron" && (
        <Choices
          options={CADENCES.map((option) => ({ key: option.value, label: option.label }))}
          value={value.cadence}
          onChange={(cadence) => onChange({ cadence })}
          disabled={disabled}
          testID="cadence"
        />
      )}
      {value.kind === "cron" && value.cadence === "weekly" && (
        <Choices
          options={WEEKDAYS.map((day, index) => ({ key: String(index), label: day.slice(0, 3) }))}
          value={value.weekday}
          onChange={(weekday) => onChange({ weekday })}
          disabled={disabled}
          testID="weekday"
        />
      )}
      {value.kind === "cron" && value.cadence === "custom" ? (
        <TextField
          value={value.custom}
          onChangeText={(custom) => onChange({ custom })}
          editable={!disabled}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="0 9 * * 1-5"
          accessibilityLabel="Cron expression"
          testID="cron-input"
        />
      ) : (
        <Card>
          {value.kind === "once" && (
            <Row
              label="Day"
              value={dayLabel(reminderDay(value.at))}
              onPress={() => open("day")}
              testID="timing-day"
            />
          )}
          <Row
            label={hourly ? "Minute" : "Time"}
            value={hourly ? `:${time.slice(3, 5)} past each hour` : timeLabel(time)}
            onPress={() => open("time")}
            first={value.kind !== "once"}
            testID="timing-time"
          />
        </Card>
      )}
      <View style={styles.summary}>{summary}</View>
      <TimeSheet
        open={sheet === "time"}
        value={time}
        minuteOnly={hourly}
        onChange={setTime}
        onClose={() => setSheet(null)}
      />
      {value.kind === "once" && (
        <DueSheet
          open={sheet === "day"}
          value={reminderDay(value.at)}
          title="Day"
          clearable={false}
          today={todayIn(timeZone)}
          onPick={(day) => day && onChange({ at: reminderAt(day, time) })}
          onClose={() => setSheet(null)}
        />
      )}
    </View>
  );
}

function Row({
  label,
  value,
  onPress,
  first = true,
  testID,
}: {
  label: string;
  value: string;
  onPress: () => void;
  first?: boolean;
  testID: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID={testID}
    >
      <Text variant="body" muted style={{ width: 72 }}>
        {label}
      </Text>
      <Text variant="label" style={{ flex: 1, textAlign: "right" }} numberOfLines={1}>
        {value}
      </Text>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fields: { gap: space(3) },
  summary: { paddingHorizontal: space(1), gap: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    minHeight: 56,
    paddingHorizontal: space(4),
  },
});
