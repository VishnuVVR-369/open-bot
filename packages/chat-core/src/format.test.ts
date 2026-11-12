import { describe, expect, it } from "vitest";
import { diffStats, elapsed, fileSize, greeting, plural } from "./format";

describe("format", () => {
  it("counts things", () => {
    expect(plural(1, "task")).toBe("1 task");
    expect(plural(3, "task")).toBe("3 tasks");
    expect(plural(0, "thing needs", "things need")).toBe("0 things need");
  });

  it("runs a stopwatch with padded seconds", () => {
    expect(elapsed(42_000)).toBe("42s");
    expect(elapsed(185_000)).toBe("3m 05s");
    expect(elapsed(-5)).toBe("0s");
  });

  it("gives sizes in the nearest unit", () => {
    expect(fileSize(900)).toBe("900 B");
    expect(fileSize(48_000)).toBe("47 KB");
    expect(fileSize(2_300_000)).toBe("2.2 MB");
    expect(fileSize(1_610_612_736)).toBe("1.5 GB");
  });

  it("greets by first name at the right time of day", () => {
    expect(greeting("Alex Kim", 3)).toBe("Good night, Alex");
    expect(greeting("Alex", 9)).toBe("Good morning, Alex");
    expect(greeting("  Alex  Kim ", 14)).toBe("Good afternoon, Alex");
    expect(greeting("Alex", 20)).toBe("Good evening, Alex");
    expect(greeting("   ", 9)).toBe("Good morning");
  });

  it("counts a diff's lines without its file headers", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "-old", "+new", "+more", " same"].join(
      "\n",
    );
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });
});
