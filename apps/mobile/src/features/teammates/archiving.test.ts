import { describe, expect, it, vi } from "vitest";
import { ArchivingTeammates } from "./archiving";

describe("teammates being archived", () => {
  it("are known until it's done, and screens hear of each change once", () => {
    const store = new ArchivingTeammates();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.set("iris", true);
    store.set("iris", true);
    expect(store.has("iris")).toBe(true);
    expect(store.has("kit")).toBe(false);
    store.set("iris", false);
    expect(store.has("iris")).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    store.set("kit", true);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
