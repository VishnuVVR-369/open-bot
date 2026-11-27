import { formatDay, parseDay } from "@open-bot/domain";
import { getCalendars } from "expo-localization";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";
import {
  calendarWeeks,
  dueShortcuts,
  monthOf,
  monthTitle,
  weekdayNames,
  weekStartFrom,
} from "../tasks";

/**
 * When a task is due: a quick day (today, tomorrow, a week out), or any day on a month's
 * calendar, which starts on the phone's first day of the week. No due date clears it. A reminder's
 * day is picked here too, with its own title, no way to clear it, and today on its schedule's clock.
 */
export function DueSheet({
  open,
  value,
  onPick,
  onClose,
  title = "Due",
  clearable = true,
  today: todayDay,
}: {
  open: boolean;
  value: string | null;
  onPick: (day: string | null) => void;
  onClose: () => void;
  title?: string;
  /** Offers "No due date". */
  clearable?: boolean;
  /** Today, which the shortcuts count from and the calendar marks: the phone's, without one. */
  today?: string;
}) {
  const colors = useColors();
  const [shown, setShown] = useState(() => monthOf(value));
  // Each time it opens, it opens on the due day's month.
  useEffect(() => {
    if (open) setShown(monthOf(value));
  }, [open, value]);
  const weekStart = weekStartFrom(getCalendars()[0]?.firstWeekday);
  const weeks = useMemo(
    () => calendarWeeks(shown.year, shown.month, weekStart),
    [shown, weekStart],
  );
  const today = todayDay ?? formatDay(new Date());
  const pick = (day: string | null) => {
    haptics.tap();
    onPick(day);
    onClose();
  };
  const step = (by: number) => {
    haptics.tap();
    setShown(({ year, month }) => {
      const date = new Date(year, month + by, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
  };

  return (
    <Sheet open={open} onClose={onClose} title={title} testID="due-sheet">
      <View style={styles.shortcuts}>
        {dueShortcuts(today).map((shortcut) => (
          <Chip
            key={shortcut.label}
            label={shortcut.label}
            selected={value === shortcut.day}
            onPress={() => pick(shortcut.day)}
          />
        ))}
        {value && clearable && (
          <Chip label="No due date" onPress={() => pick(null)} testID="due-clear" />
        )}
      </View>
      <View style={styles.calendar}>
        <View style={styles.monthRow}>
          <Text variant="label" accessibilityRole="header" testID="due-month">
            {monthTitle(shown.year, shown.month)}
          </Text>
          <View style={styles.arrows}>
            <Arrow label="Previous month" onPress={() => step(-1)}>
              <ChevronLeft size={20} color={colors.foreground} />
            </Arrow>
            <Arrow label="Next month" onPress={() => step(1)} testID="due-next-month">
              <ChevronRight size={20} color={colors.foreground} />
            </Arrow>
          </View>
        </View>
        <View style={styles.week}>
          {weekdayNames(weekStart).map((name, index) => (
            <Text key={index} variant="caption" muted style={styles.weekday}>
              {name}
            </Text>
          ))}
        </View>
        {weeks.map((week) => (
          <View key={week[0]!.day} style={styles.week}>
            {week.map((cell) => {
              const selected = cell.day === value;
              const isToday = cell.day === today;
              return (
                <Pressable
                  key={cell.day}
                  onPress={() => pick(cell.day)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={parseDay(cell.day).toDateString()}
                  style={styles.cell}
                  testID={`due-day-${cell.day}`}
                >
                  <View
                    style={[
                      styles.day,
                      selected && { backgroundColor: colors.primary },
                      !selected && isToday && { borderWidth: 1, borderColor: colors.foreground },
                    ]}
                  >
                    <Text
                      variant="small"
                      style={{
                        color: selected
                          ? colors.primaryForeground
                          : cell.inMonth
                            ? colors.foreground
                            : colors.mutedForeground,
                        opacity: cell.inMonth || selected ? 1 : 0.6,
                        fontWeight: selected || isToday ? "600" : "400",
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {cell.date}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </Sheet>
  );
}

function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: colors.primary, borderColor: colors.primary }
          : { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
      testID={testID}
    >
      <Text
        variant="small"
        style={{
          fontWeight: "500",
          color: selected ? colors.primaryForeground : colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Arrow({
  label,
  onPress,
  children,
  testID,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
      style={styles.arrow}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shortcuts: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space(2),
    paddingHorizontal: space(5),
    paddingBottom: space(2),
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
  calendar: { paddingHorizontal: space(3), paddingBottom: space(1) },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: space(2),
    minHeight: 44,
  },
  arrows: { flexDirection: "row" },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  week: { flexDirection: "row" },
  weekday: { flex: 1, textAlign: "center", paddingVertical: space(1.5), fontWeight: "500" },
  cell: { flex: 1, height: 44, alignItems: "center", justifyContent: "center" },
  day: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
});
