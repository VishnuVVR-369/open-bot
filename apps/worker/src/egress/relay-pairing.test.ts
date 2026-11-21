// The egress relay refusing phones whose pairing was revoked or replaced, however the revoke arrives.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSE_REVOKED } from "./relay";
import { cleanUp, PHONE_ID, setup, until } from "./relay.testing";

afterEach(cleanUp);

describe("egress relay", () => {
  it("refuses a phone whose pairing was revoked or replaced", async () => {
    const env = await setup();
    env.store.unpair(PHONE_ID);
    const revoked = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    const code = await new Promise((resolve) => revoked.socket.once("close", resolve));
    expect(code).toBe(CLOSE_REVOKED);

    env.store.pair(PHONE_ID, 2);
    const stale = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    expect(await new Promise((resolve) => stale.socket.once("close", resolve))).toBe(CLOSE_REVOKED);
    const current = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 2 });
    // The relay adopts the phone once the server's side is open, which can be before the client's.
    await until(
      () =>
        env.relay.connectedPhones.includes(PHONE_ID) &&
        current.socket.readyState === WebSocket.OPEN,
      "the re-paired phone",
    );
    expect(current.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("lets a revoke that arrives during an attach win", async () => {
    const env = await setup();
    let release!: () => void;
    env.store.readDelay = new Promise((resolve) => (release = resolve));
    const reads = env.store.reads;
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(() => env.store.reads > reads, "the attach to read the pairing");
    // The attach is reading the pairing; the revoke happens in the database and is queued.
    env.store.unpair(PHONE_ID);
    const revoking = env.relay.revoke(PHONE_ID, 1);
    env.store.readDelay = null;
    release();
    await revoking;
    expect(await new Promise((resolve) => raw.socket.once("close", resolve))).toBe(CLOSE_REVOKED);
    expect(env.relay.connectedPhones).toEqual([]);
  });

  it("ignores a delayed revoke of an older pairing", async () => {
    const env = await setup();
    env.store.pair(PHONE_ID, 2);
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 2 });
    await until(
      () =>
        env.relay.connectedPhones.includes(PHONE_ID) && raw.socket.readyState === WebSocket.OPEN,
      "the phone",
    );
    await env.relay.revoke(PHONE_ID, 1);
    expect(raw.socket.readyState).toBe(WebSocket.OPEN);
    expect(env.relay.connectedPhones).toEqual([PHONE_ID]);
  });

  it("catches a lost revoke with the reconciler", async () => {
    const env = await setup();
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(() => env.relay.connectedPhones.includes(PHONE_ID), "the phone");
    env.store.unpair(PHONE_ID);
    expect(await new Promise((resolve) => raw.socket.once("close", resolve))).toBe(CLOSE_REVOKED);
  });
});
