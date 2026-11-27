import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { setEnabledOptimistically } from "./optimistic";

const KEY = ["schedules", "list"];
const list = () => [
  { id: "a", enabled: true, title: "Morning brief" },
  { id: "b", enabled: false, title: "Weekly retro" },
];

describe("turning an automation on or off", () => {
  it("shows the switch where you put it while the write is on its way", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, list());
    let seen: unknown;
    const error = await setEnabledOptimistically(client, KEY, "a", false, async () => {
      seen = client.getQueryData(KEY);
      return { error: null };
    });
    expect(error).toBeNull();
    expect(seen).toEqual([
      { id: "a", enabled: false, title: "Morning brief" },
      { id: "b", enabled: false, title: "Weekly retro" },
    ]);
  });

  it("puts the switch back when the write fails", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, list());
    const error = await setEnabledOptimistically(client, KEY, "b", true, async () => ({
      error: new Error("That reminder's time has passed."),
    }));
    expect(error).toBeInstanceOf(Error);
    expect(client.getQueryData(KEY)).toEqual(list());
  });

  it("calls off a read from before the tap, so its answer can't undo the switch", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, list());
    // A read that started before the tap and answers after it, with the list as it was.
    let answer: (value: ReturnType<typeof list>) => void = () => {};
    const stale = client.fetchQuery({
      queryKey: KEY,
      queryFn: () => new Promise<ReturnType<typeof list>>((resolve) => (answer = resolve)),
      staleTime: 0,
    });
    await setEnabledOptimistically(client, KEY, "a", false, async () => {
      answer(list());
      await stale.catch(() => {});
      return { error: null };
    });
    expect(client.getQueryData<ReturnType<typeof list>>(KEY)?.[0]?.enabled).toBe(false);
  });
});
