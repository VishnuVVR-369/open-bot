import { describe, expect, it } from "vitest";
import { inOrder } from "./in-order";

/** A stand-in server that saves what it's sent, answering when the test says. */
function standInServer() {
  const saved: (string | null)[] = [];
  const waiting: (() => void)[] = [];
  return {
    saved,
    started: () => waiting.length,
    send: (value: string | null) => () =>
      new Promise<string | null>((resolve) =>
        waiting.push(() => {
          saved.push(value);
          resolve(value);
        }),
      ),
    answerNext: async () => {
      waiting.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("writes in order", () => {
  it("doesn't send a newer write until the older one is saved, so the newest wins", async () => {
    const server = standInServer();
    const write = inOrder();
    const up = write(server.send("up"));
    const cleared = write(server.send(null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.started()).toBe(1);
    await server.answerNext();
    expect(server.started()).toBe(1);
    await server.answerNext();
    expect(server.saved).toEqual(["up", null]);
    expect(await up).toEqual({ value: "up", newest: false });
    expect(await cleared).toEqual({ value: null, newest: true });
  });

  it("keeps going after a write fails", async () => {
    const write = inOrder();
    const failed = write(() => Promise.reject(new Error("offline")));
    const next = write(() => Promise.resolve("down"));
    await expect(failed).rejects.toThrow("offline");
    expect(await next).toEqual({ value: "down", newest: true });
  });
});
