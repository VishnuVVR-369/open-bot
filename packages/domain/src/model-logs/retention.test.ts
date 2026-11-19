import { describe, expect, it } from "vitest";
import {
  expiredParams,
  hasExpired,
  modelLogRetentionSchema,
  retentionCutoff,
  retentionLabel,
} from "./retention";

const now = new Date("2026-11-17T12:00:00.000Z");

describe("retentionCutoff", () => {
  it("is whole days before now", () => {
    expect(retentionCutoff(now, 30)).toEqual(new Date("2026-10-18T12:00:00.000Z"));
    expect(retentionCutoff(now, 1)).toEqual(new Date("2026-11-16T12:00:00.000Z"));
  });

  it("keeps everything when there is no window, or one that isn't a positive whole number", () => {
    expect(retentionCutoff(now, null)).toBeNull();
    expect(retentionCutoff(now, undefined)).toBeNull();
    expect(retentionCutoff(now, 0)).toBeNull();
    expect(retentionCutoff(now, -3)).toBeNull();
    expect(retentionCutoff(now, 2.5)).toBeNull();
  });
});

describe("hasExpired", () => {
  it("expires only what is strictly older than the cutoff", () => {
    const cutoff = retentionCutoff(now, 7)!;
    expect(hasExpired(new Date(cutoff.getTime() - 1), now, 7)).toBe(true);
    expect(hasExpired(cutoff, now, 7)).toBe(false);
    expect(hasExpired(new Date(0), now, null)).toBe(false);
  });
});

describe("the setting", () => {
  it("takes forever or a whole number of days up to ten years", () => {
    expect(modelLogRetentionSchema.parse(null)).toBeNull();
    expect(modelLogRetentionSchema.parse(30)).toBe(30);
    expect(modelLogRetentionSchema.safeParse(0).success).toBe(false);
    expect(modelLogRetentionSchema.safeParse(1.5).success).toBe(false);
    expect(modelLogRetentionSchema.safeParse(3651).success).toBe(false);
  });

  it("reads in plain words", () => {
    expect(retentionLabel(null)).toBe("Forever");
    expect(retentionLabel(365)).toBe("1 year");
    expect(retentionLabel(30)).toBe("30 days");
  });
});

describe("expiredParams", () => {
  it("keeps how a request was asked and drops whatever it said", () => {
    expect(
      expiredParams({
        model: "gpt-5",
        input: "private text",
        messages: [{ role: "user", content: "private" }],
        prompt: "private",
        metadata: { note: "private" },
        stream: true,
        max_output_tokens: 4000,
        reasoning: { effort: "high", summary: "auto", context: "private" },
        text: {
          verbosity: "low",
          format: { type: "json_schema", schema: { description: "private" } },
        },
        tool_choice: { type: "function", name: "shell", description: "private" },
        include: ["reasoning.encrypted_content", { note: "private" }],
        prompt_cache_key: "thread-1",
      }),
    ).toEqual({
      model: "gpt-5",
      stream: true,
      max_output_tokens: 4000,
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "low" },
      tool_choice: { type: "function", name: "shell" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "thread-1",
    });
  });

  it("drops a kept name holding something other than a plain value", () => {
    expect(expiredParams({ model: { text: "private" }, tool_choice: "auto" })).toEqual({
      tool_choice: "auto",
    });
    expect(expiredParams(null)).toBeNull();
    expect(expiredParams("private")).toBeNull();
  });
});
