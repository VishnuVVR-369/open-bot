import { describe, expect, it } from "vitest";
import {
  cadenceCron,
  cadenceOf,
  describeCron,
  formatLocalDateTime,
  nextCronRun,
  parseLocalDateTime,
  validateCron,
} from "./schedule";

describe("schedules", () => {
  it("reads wall-clock times in the given timezone", () => {
    expect(parseLocalDateTime("2026-10-14T09:00", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-14T03:30:00.000Z",
    );
    expect(parseLocalDateTime("2026-01-14T09:00", "America/New_York").toISOString()).toBe(
      "2026-01-14T14:00:00.000Z",
    );
    expect(parseLocalDateTime("2026-07-14T09:00", "America/New_York").toISOString()).toBe(
      "2026-07-14T13:00:00.000Z",
    );
    expect(parseLocalDateTime("2026-10-14T09:00:00Z", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-14T09:00:00.000Z",
    );
  });

  it("computes the next cron run in the timezone", () => {
    const after = new Date("2026-10-13T10:00:00Z");
    expect(nextCronRun("0 8 * * *", "Asia/Kolkata", after).toISOString()).toBe(
      "2026-10-14T02:30:00.000Z",
    );
  });

  it("validates and describes cron expressions", () => {
    expect(validateCron("0 8 * * 1-5", "UTC")).toBeNull();
    expect(validateCron("0 8 * *", "UTC")).toMatch(/5-field/);
    expect(validateCron("99 8 * * *", "UTC")).not.toBeNull();
    expect(describeCron("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
    expect(describeCron("30 18 * * *")).toBe("Every day at 6:30 PM");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 9:00 AM");
  });

  it("writes moments back as wall-clock time in the timezone", () => {
    const date = new Date("2026-10-14T03:30:00.000Z");
    expect(formatLocalDateTime(date, "Asia/Kolkata")).toBe("2026-10-14T09:00");
    expect(formatLocalDateTime(new Date("2026-01-14T05:00:00Z"), "America/New_York")).toBe(
      "2026-01-14T00:00",
    );
    expect(parseLocalDateTime(formatLocalDateTime(date, "Europe/Berlin"), "Europe/Berlin")).toEqual(
      date,
    );
  });

  it("reads cron expressions back into the form's cadences", () => {
    for (const cron of ["5 9 * * *", "0 17 * * 1-5", "30 8 * * 3", "15 * * * *"]) {
      const { cadence, time, weekday } = cadenceOf(cron);
      expect(cadence).not.toBe("custom");
      expect(cadenceCron(cadence, time, weekday, "")).toBe(cron);
    }
    expect(cadenceOf("0 9 1 * *").cadence).toBe("custom");
    expect(cadenceOf("*/5 * * * *").cadence).toBe("custom");
    expect(cadenceOf("0 9 * * 1,3").cadence).toBe("custom");
  });
});
