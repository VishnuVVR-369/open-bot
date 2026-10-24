import { describe, expect, it } from "vitest";
import { undeletablePath } from "./bots";

describe("deleting on the computer", () => {
  it("keeps the folders the computer needs and active teammates' workspaces", () => {
    const active = ["iris", "rex"];
    expect(undeletablePath("/home/bot/bots", active)).not.toBeNull();
    expect(undeletablePath("/home/bot/shared", active)).not.toBeNull();
    expect(undeletablePath("/home/bot/shared/downloads", active)).not.toBeNull();
    expect(undeletablePath("/home/bot/.agents/skills/x", active)).not.toBeNull();
    expect(undeletablePath("/home/bot/bots/iris", active)).not.toBeNull();
  });

  it("allows files, and the workspaces of teammates who are gone", () => {
    const active = ["iris"];
    expect(undeletablePath("/home/bot/bots/iris/notes.md", active)).toBeNull();
    expect(undeletablePath("/home/bot/bots/old-bot", active)).toBeNull();
    expect(undeletablePath("/home/bot/shared/report.pdf", active)).toBeNull();
  });
});
