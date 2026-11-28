import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { space } from "@/theme";
import { clockOf, minuteChoices, timeOf } from "../automations";
import { Choices } from "./automation-parts";

const HOURS = Array.from({ length: 12 }, (_, index) => index + 1);

/**
 * A time of day on a 12-hour clock: the hour, morning or afternoon, and the minute in fives (a
 * minute set elsewhere stays offered). `minuteOnly` is for "every hour", which runs at a minute.
 * Each tap applies; Done closes.
 */
export function TimeSheet({
  open,
  value,
  minuteOnly = false,
  onChange,
  onClose,
}: {
  open: boolean;
  /** "09:00", 24-hour. */
  value: string;
  minuteOnly?: boolean;
  onChange: (time: string) => void;
  onClose: () => void;
}) {
  const { hour12, minute, pm } = clockOf(value);
  const set = (next: Partial<{ hour12: number; minute: number; pm: boolean }>) =>
    onChange(timeOf(next.hour12 ?? hour12, next.minute ?? minute, next.pm ?? pm));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={minuteOnly ? "Minute past the hour" : "Time"}
      testID="time-sheet"
    >
      <View style={styles.body}>
        {!minuteOnly && (
          <>
            <Group label="Hour">
              <Choices
                options={HOURS.map((hour) => ({ key: hour, label: String(hour) }))}
                value={hour12}
                onChange={(hour) => set({ hour12: hour })}
                testID="time-hour"
              />
            </Group>
            <Choices
              options={[
                { key: "am", label: "AM" },
                { key: "pm", label: "PM" },
              ]}
              value={pm ? "pm" : "am"}
              onChange={(half) => set({ pm: half === "pm" })}
              testID="time-half"
            />
          </>
        )}
        <Group label="Minute">
          <Choices
            options={minuteChoices(minute).map((entry) => ({
              key: entry,
              label: `:${String(entry).padStart(2, "0")}`,
            }))}
            value={minute}
            onChange={(entry) => set({ minute: entry })}
            testID="time-minute"
          />
        </Group>
        <Button title="Done" onPress={onClose} testID="time-done" />
      </View>
    </Sheet>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="overline" muted>
        {label}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space(5), paddingBottom: space(1), gap: space(4) },
});
