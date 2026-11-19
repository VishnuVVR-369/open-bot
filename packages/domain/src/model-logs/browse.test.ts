import { describe, expect, it } from "vitest";
import {
  HIT_END,
  HIT_START,
  keysetCursor,
  MODEL_LOG_SEARCH_MAX,
  parseKeysetCursor,
  runStatusesFor,
  searchTerms,
  snippetParts,
  SNIPPET_LEAD_CHARS,
  trimSnippetLead,
} from "./browse";

describe("searchTerms", () => {
  it("trims, collapses spaces and treats blank as no search", () => {
    expect(searchTerms("  flaky   test\n run ")).toBe("flaky test run");
    expect(searchTerms("   ")).toBeNull();
    expect(searchTerms(undefined)).toBeNull();
  });

  it("cuts a long search to the limit", () => {
    expect(searchTerms("a".repeat(500))).toHaveLength(MODEL_LOG_SEARCH_MAX);
  });
});

describe("keyset cursor", () => {
  const id = "0b9f3f4e-7d0c-4c3b-9a61-2f0f6c1d2e3a";

  it("round-trips the exact time and id", () => {
    const cursor = keysetCursor("2026-11-17T08:01:02.123456Z", id);
    expect(parseKeysetCursor(cursor)).toEqual({ at: "2026-11-17T08:01:02.123456Z", id });
  });

  it("refuses anything it didn't make", () => {
    expect(parseKeysetCursor("")).toBeNull();
    expect(parseKeysetCursor("2026-11-17T00:00:00Z")).toBeNull();
    expect(parseKeysetCursor("2026-11-17T08:01:02.123Z_" + id)).toBeNull();
    expect(parseKeysetCursor(`2026-11-17T08:01:02.123456Z_${id}; drop table runs`)).toBeNull();
  });
});

describe("runStatusesFor", () => {
  it("maps each filter to the run statuses it stands for", () => {
    expect(runStatusesFor("done")).toEqual(["completed"]);
    expect(runStatusesFor("stopped")).toEqual(["interrupted"]);
    expect(runStatusesFor("working")).toEqual(["queued", "starting", "running", "waiting"]);
  });
});

describe("snippetParts", () => {
  it("splits a headline into hits and the text around them", () => {
    expect(snippetParts(`the ${HIT_START}flaky${HIT_END} test ${HIT_START}run${HIT_END}`)).toEqual([
      { text: "the ", hit: false },
      { text: "flaky", hit: true },
      { text: " test ", hit: false },
      { text: "run", hit: true },
    ]);
  });

  it("never shows a stray marker, and keeps text with none as is", () => {
    expect(snippetParts(`a ${HIT_START}b`)).toEqual([
      { text: "a ", hit: false },
      { text: "b", hit: true },
    ]);
    expect(snippetParts(`x${HIT_END}y`)).toEqual([{ text: "xy", hit: false }]);
    expect(snippetParts("<b>not html</b>")).toEqual([{ text: "<b>not html</b>", hit: false }]);
  });
});

describe("trimSnippetLead", () => {
  const hit = (word: string) => `${HIT_START}${word}${HIT_END}`;

  it("keeps only a few words before the first hit, and marks the cut", () => {
    const snippet = `FAIL src/recurrence.test.ts > nextOccurrence > keeps the wall-clock time across a ${hit("daylight")} ${hit("saving")} change`;
    const trimmed = trimSnippetLead(snippet);
    expect(trimmed).toBe(`… wall-clock time across a ${hit("daylight")} ${hit("saving")} change`);
    expect(trimmed.indexOf(HIT_START)).toBeLessThanOrEqual(SNIPPET_LEAD_CHARS + 2);
  });

  it("puts the snippet on one line", () => {
    expect(trimSnippetLead(`Be brief.\n\n${hit("Esperanto")}\ttides`)).toBe(
      `Be brief. ${hit("Esperanto")} tides`,
    );
  });

  it("cuts a long word before the hit rather than push the hit out of view", () => {
    const path = "a/".repeat(40) + "file.ts";
    expect(trimSnippetLead(`${path} ${hit("zeppelin")}`)).toBe(`… ${hit("zeppelin")}`);
    expect(trimSnippetLead(`see ${path}${hit("zeppelin")}`)).toBe(`…${hit("zeppelin")}`);
  });

  it("leaves a snippet that starts at its hit, or has none, as it is", () => {
    expect(trimSnippetLead(`${hit("Lisbon")} on TAP`)).toBe(`${hit("Lisbon")} on TAP`);
    expect(trimSnippetLead("two short words")).toBe("two short words");
    expect(trimSnippetLead(`on ${hit("TAP")}`)).toBe(`on ${hit("TAP")}`);
  });
});
