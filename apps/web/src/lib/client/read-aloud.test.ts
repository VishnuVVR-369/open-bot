import { expect, it } from "vitest";
import { speakable } from "@/lib/client/read-aloud";

it("speakable turns Markdown into sentences with pauses", () => {
  expect(
    speakable(
      "Here are **three** tips:\n\n1. Weigh it\n2. Grind [finer](https://x.y)\n3. Tamp level.",
    ),
  ).toBe("Here are three tips: Weigh it. Grind finer. Tamp level.");
});
