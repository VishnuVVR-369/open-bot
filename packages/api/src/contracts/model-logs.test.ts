import { describe, expect, it } from "vitest";
import { runsCursorSchema } from "./model-logs";

const ID = "6f1c2a4e-9b3d-4c5e-8f7a-1b2c3d4e5f60";
const cursor = (at: string) => `${at}_${ID}`;

describe("a runs cursor", () => {
  it("takes a real time to the microsecond, a leap day included", () => {
    for (const at of [
      "2026-11-17T10:00:00.123456Z",
      "2024-02-29T23:59:59.999999Z",
      "2000-02-29T00:00:00.000000Z",
      "0001-01-01T00:00:00.000000Z",
    ])
      expect(runsCursorSchema.safeParse(cursor(at)).success, at).toBe(true);
  });

  it("refuses a time that doesn't exist, though it is shaped like one", () => {
    for (const at of [
      "2026-99-99T00:00:00.000000Z",
      "2026-00-10T00:00:00.000000Z",
      "2026-02-29T00:00:00.000000Z",
      "1900-02-29T00:00:00.000000Z",
      "2026-04-31T00:00:00.000000Z",
      "2026-11-00T00:00:00.000000Z",
      "2026-11-17T24:00:00.000000Z",
      "2026-11-17T10:60:00.000000Z",
      "2026-11-17T10:00:60.000000Z",
      "0000-01-01T00:00:00.000000Z",
    ])
      expect(runsCursorSchema.safeParse(cursor(at)).success, at).toBe(false);
  });

  it("refuses less precision, or no run id", () => {
    expect(runsCursorSchema.safeParse(cursor("2026-11-17T10:00:00.123Z")).success).toBe(false);
    expect(runsCursorSchema.safeParse("2026-11-17T10:00:00.123456Z").success).toBe(false);
  });
});
