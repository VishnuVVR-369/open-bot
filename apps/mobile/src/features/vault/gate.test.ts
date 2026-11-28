import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../../lib/query";
import {
  asksOnReturn,
  createVaultScreens,
  forgetVault,
  shouldAskHere,
  VAULT_SETTLE_MS,
  vaultEditorHeader,
} from "./gate";

function setup() {
  let now = 0;
  const timers: { run: () => void; at: number; cleared: boolean }[] = [];
  const calls: string[] = [];
  const screens = createVaultScreens({
    setTimer: (run, ms) => {
      const timer = { run, at: now + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    hide: () => calls.push("hide"),
    left: () => calls.push("left"),
  });
  return {
    screens,
    calls,
    advance(ms: number) {
      now += ms;
      for (const timer of timers)
        if (!timer.cleared && timer.at <= now) {
          timer.cleared = true;
          timer.run();
        }
    },
  };
}

describe("being in the vault", () => {
  it("hides from screenshots from the first vault screen, and leaves a second after the last", () => {
    const t = setup();
    const list = t.screens.enter();
    expect(t.calls).toEqual(["hide"]);
    list();
    t.advance(VAULT_SETTLE_MS - 1);
    expect(t.calls).toEqual(["hide"]);
    expect(t.screens.hidden()).toBe(true);
    t.advance(1);
    expect(t.calls).toEqual(["hide", "left"]);
    expect(t.screens.hidden()).toBe(false);
  });

  it("isn't left by moving between vault screens", () => {
    const t = setup();
    const list = t.screens.enter();
    // The list opens an editor: the list blurs a moment before the editor is focused.
    list();
    t.advance(200);
    const editor = t.screens.enter();
    t.advance(VAULT_SETTLE_MS * 3);
    expect(t.calls).toEqual(["hide"]);
    // The editor saves and goes back: the list is focused again before the editor goes.
    const back = t.screens.enter();
    editor();
    editor();
    t.advance(VAULT_SETTLE_MS * 3);
    expect(t.screens.count()).toBe(1);
    expect(t.calls).toEqual(["hide"]);
    back();
    t.advance(VAULT_SETTLE_MS);
    expect(t.calls).toEqual(["hide", "left"]);
  });

  it("is left when a purchase opens its chat, though the budget stays mounted under it", () => {
    const t = setup();
    // The budget screen blurs as the chat comes to the front; the chat isn't a vault screen.
    const budget = t.screens.enter();
    budget();
    t.advance(VAULT_SETTLE_MS);
    expect(t.calls).toEqual(["hide", "left"]);
    // Back from the chat: in the vault again, which hides and asks again.
    t.screens.enter();
    expect(t.calls).toEqual(["hide", "left", "hide"]);
  });

  it("drops what the vault read, and nothing else, once you leave", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.vault, []);
    client.setQueryData(queryKeys.spending("t1"), { budgetCents: 5000 });
    client.setQueryData(queryKeys.spending("t2"), { budgetCents: null });
    client.setQueryData(["teammates", "list"], []);
    forgetVault(client);
    expect(client.getQueryData(queryKeys.vault)).toBeUndefined();
    expect(client.getQueryData(queryKeys.spending("t1"))).toBeUndefined();
    expect(client.getQueryData(queryKeys.spending("t2"))).toBeUndefined();
    expect(client.getQueryData(["teammates", "list"])).toEqual([]);
  });
});

describe("when the vault asks for your fingerprint", () => {
  it("asks on a screen in front, with the app on screen, only while it's locked", () => {
    expect(shouldAskHere({ open: false, focused: true, active: true })).toBe(true);
    expect(shouldAskHere({ open: true, focused: true, active: true })).toBe(false);
    // Behind another screen, or with the app going away (the prompt itself makes it inactive).
    expect(shouldAskHere({ open: false, focused: false, active: true })).toBe(false);
    expect(shouldAskHere({ open: false, focused: true, active: false })).toBe(false);
  });

  it("leaves coming back to the app's lock when that asks first", () => {
    const appRelocks = (at: number | null, now: number) => at !== null && now - at >= 300_000;
    const back = { appRelocks, backgroundedAt: 0, now: 300_000 };
    expect(asksOnReturn({ ...back, appLock: true })).toBe(false);
    expect(asksOnReturn({ ...back, appLock: false })).toBe(true);
    expect(asksOnReturn({ ...back, appLock: true, now: 60_000 })).toBe(true);
  });

  it("names the item in the header only while it's open", () => {
    expect(vaultEditorHeader("login", "GitHub", true)).toBe("Edit GitHub");
    expect(vaultEditorHeader("login", "GitHub", false)).toBe("Edit login");
    expect(vaultEditorHeader("card", "Personal Visa", false)).toBe("Edit card");
    expect(vaultEditorHeader("card", null, false)).toBe("Add a card");
  });
});
