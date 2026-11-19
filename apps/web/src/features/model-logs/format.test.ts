import { describe, expect, it } from "vitest";
import {
  between,
  formatCost,
  formatMs,
  formatSize,
  requestKindLabel,
  runInspectorHref,
  toolItemLabel,
} from "./format";

describe("model log formatting", () => {
  it("prices a single request to the hundredth of a cent, and larger ones in dollars", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(2_550)).toBe("$0.0026");
    expect(formatCost(1_250_000)).toBe("$1.25");
  });

  it("says how long a request took, in milliseconds under a second", () => {
    expect(between("2026-11-17T10:00:00.000Z", "2026-11-17T10:00:00.412Z")).toBe("412 ms");
    expect(between("2026-11-17T10:00:00.000Z", null)).toBeNull();
    expect(between("2026-11-17T10:00:05.000Z", "2026-11-17T10:00:00.000Z")).toBeNull();
  });

  it("names sizes and request kinds plainly", () => {
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(3_000_000)).toBe("2.9 MB");
    expect(requestKindLabel("prewarm")).toBe("Prewarm");
    expect(requestKindLabel(null)).toBe("Request");
    expect(requestKindLabel("embedding")).toBe("Embedding");
    expect(toolItemLabel("commandExecution")).toBe("Command");
    expect(toolItemLabel("dynamicToolCall")).toBe("open-bot tool");
    expect(toolItemLabel("somethingNew")).toBe("somethingNew");
  });

  it("links a run to its inspector under Settings", () => {
    expect(runInspectorHref("r1")).toBe("/settings/model-logs/runs/r1");
  });

  it("times a tool in milliseconds, then tenths of a second, then whole seconds", () => {
    expect(formatMs(null)).toBe("-");
    expect(formatMs(212.4)).toBe("212 ms");
    expect(formatMs(1450)).toBe("1.4s");
    expect(formatMs(75_000)).toBe("1m 15s");
  });
});
