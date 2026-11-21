// The egress relay waking a paired phone when a screen needs browsing, and what the phone says back.
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, echo, echoServer, PHONE_ID, setup, until } from "./relay.testing";

afterEach(cleanUp);

describe("egress relay", () => {
  it("wakes the phone when a screen needs browsing, and holds the connection until it's there", async () => {
    const env = await setup({ mode: "require", phoneMode: "fallback" });
    const port = await echoServer();
    // The wake reaches the phone, which connects a moment later.
    let phone: ReturnType<typeof env.phone> | null = null;
    env.onPush((stage) => {
      if (stage === "wake" && !phone) setTimeout(() => (phone = env.phone()), 200);
    });
    await until(() => env.router.state.configured, "the config");
    env.router.noteDemand("teammate-1");
    await until(() => env.pushes.length === 1, "the wake");
    expect(env.relay.status.path).toBe("waiting");
    expect(env.relay.status.phones[0]!.waking).toMatchObject({ stage: "wake" });

    const socket = await env.connect(port);
    expect(await echo(socket, "through the woken phone")).toBe("through the woken phone");
    expect(phone!.lookups).toHaveLength(1);
    expect(env.relay.status.path).toBe("phone");
    expect(env.relay.status.phones[0]).toMatchObject({ online: true, waking: null });
  });

  it("stops waking a phone that says it can't help, and botd stops holding for it", async () => {
    const env = await setup({ mode: "require", phoneMode: "fallback" });
    const port = await echoServer();
    env.onPush((stage) => {
      if (stage !== "wake") return;
      const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
      raw.socket.once("open", () => {
        raw.socket.send(JSON.stringify({ type: "unavailable", reason: "wifi-only" }));
        raw.socket.close();
      });
    });
    env.router.noteDemand("teammate-1");
    await until(() => env.relay.status.phones[0]!.unavailable !== null, "the report");
    expect(env.relay.status.phones[0]!.unavailable).toMatchObject({
      reason: "wifi-only",
      message: "Phone is on mobile data",
    });
    await until(() => !env.router.state.agentOnline, "the phone to leave");
    await expect(env.connect(port)).rejects.toThrow("SOCKS reply 2");
  });

  it("takes a phone's word that it is back over a report still on its way", async () => {
    const env = await setup({ mode: "require", phoneMode: "fallback" });
    const first = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    first.socket.once("open", () =>
      first.socket.send(JSON.stringify({ type: "unavailable", reason: "wifi-only", seq: 2 })),
    );
    await until(() => env.relay.status.phones[0]!.unavailable !== null, "the report");
    first.socket.close();
    await until(() => env.relay.status.phones[0]!.online === false, "the phone to leave");

    const second = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    second.socket.once("open", () =>
      second.socket.send(JSON.stringify({ type: "available", seq: 2 })),
    );
    await until(() => env.relay.status.phones[0]!.online === true, "the phone");
    await until(() => env.relay.status.phones[0]!.unavailable === null, "the report to clear");
    // The same report, late through the device route, doesn't count again.
    env.wake.unavailable(PHONE_ID, "wifi-only", 2);
    expect(env.relay.status.phones[0]!.unavailable).toBeNull();
  });
});
