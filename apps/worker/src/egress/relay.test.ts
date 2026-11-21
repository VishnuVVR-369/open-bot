// The egress relay end to end: the computer tunnel pausing and resuming, and which device
// (the Mac, a phone, or none) carries the computer's connections in each mode.
import type { Socket } from "node:net";
import { egressStatusSchema } from "@open-bot/api";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { cleanUp, echo, echoServer, PHONE_2_ID, PHONE_ID, setup, until } from "./relay.testing";

afterEach(cleanUp);

describe("egress relay", () => {
  it("pauses only the computer tunnel and keeps desktop/phone agents attached through stale reconnect timers", async () => {
    const env = await setup();
    env.desktop();
    const phone = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(
      () => env.relay.status.agents.length >= 1 && env.relay.computerConnected,
      "agents and computer",
    );
    const before = env.tunnels.length;
    env.relay.pauseComputer();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(env.relay.computerConnected).toBe(false);
    expect(env.relay.status.agents.some((agent) => agent.kind === "desktop")).toBe(true);
    expect(phone.socket.readyState).toBe(WebSocket.OPEN);
    expect(env.tunnels.length).toBe(before);
    await env.relay.resumeComputer();
    await until(() => env.relay.computerConnected, "computer resumes");
    expect(env.relay.status.agents.some((agent) => agent.kind === "desktop")).toBe(true);
  });

  it("reloads durable routing and revocations before resuming a sleeping computer", async () => {
    const env = await setup();
    const phone = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(() => env.relay.status.agents.some((a) => a.kind === "phone"), "phone attached");
    env.relay.pauseComputer();
    // Simulate a saved edit whose notification was lost. Periodic reconciliation is not enough.
    env.store.mode = "require";
    env.store.phones = [];
    await env.relay.resumeComputer();
    await until(
      () => env.relay.computerConnected && env.router.state.mode === "require",
      "fresh configuration applied",
    );
    await until(() => phone.socket.readyState !== WebSocket.OPEN, "revoked phone disconnected");
    expect(env.relay.status.agents.some((a) => a.kind === "phone")).toBe(false);
    expect(env.router.state.agentOnline).toBe(false);
  });

  it("carries connections through the desktop, with a status that matches the API schema", async () => {
    const env = await setup();
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    await until(() => env.router.state.agentOnline, "botd to see a device");

    const socket = await env.connect(port);
    expect(await echo(socket, "hello")).toBe("hello");
    expect(mac.lookups).toEqual(["127.0.0.1"]);
    socket.end();

    const status = egressStatusSchema.parse(env.relay.status);
    expect(status.path).toBe("desktop");
    expect(status.agents).toMatchObject([{ kind: "desktop", role: "active" }]);
    expect(status.phones).toMatchObject([{ id: PHONE_ID, online: false }]);
  });

  it("prefers the Mac in fallback and lets the standby phone go after the grace", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const phone = env.phone();
    await until(() => phone.role === "standby", "the phone to stand by");
    expect(env.relay.status.agents.map((agent) => [agent.kind, agent.role])).toEqual([
      ["desktop", "active"],
      ["phone", "standby"],
    ]);
    await until(() => phone.role === "release", "the phone's release");
    expect(phone.roles).toEqual(["standby", "release"]);
  });

  it("prefers the phone in always, and the Mac stands by", async () => {
    const env = await setup({ phoneMode: "always" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const phone = env.phone();
    await until(() => phone.role === "active" && mac.role === "standby", "the phone to take over");
    const socket = await env.connect(port);
    expect(await echo(socket, "via phone")).toBe("via phone");
    expect(phone.lookups).toHaveLength(1);
    expect(mac.lookups).toHaveLength(0);
    expect(env.relay.status.path).toBe("phone");
  });

  it("releases phones at once when the phone mode is off, and tells them the policy", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const raw = env.rawAgent({ kind: "phone", id: PHONE_ID, name: "Phone", generation: 1 });
    await until(
      () => raw.texts.some((message) => message.type === "role" && message.role === "active"),
      "the phone to be active",
    );
    expect(raw.texts).toContainEqual({ type: "policy", phoneMode: "fallback" });
    await env.relay.setPhoneMode("off");
    await until(
      () => raw.texts.some((message) => message.type === "role" && message.role === "release"),
      "the release",
    );
    expect(raw.texts).toContainEqual({ type: "policy", phoneMode: "off" });
    expect(env.relay.status.path).toBe("direct");
  });

  it("keeps a draining Mac's stream working after a switch, then resets it at the grace end", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const old = await env.connect(port);
    expect(await echo(old, "before")).toBe("before");
    const phone = env.phone();
    await until(() => phone.role === "standby", "the phone to stand by");

    await env.relay.setPhoneMode("always");
    await until(() => phone.role === "active" && mac.role === "standby", "the switch");
    // The old stream still goes through the Mac; new ones go through the phone.
    expect(await echo(old, "during")).toBe("during");
    const fresh = await env.connect(port);
    expect(await echo(fresh, "new")).toBe("new");
    expect(phone.lookups).toHaveLength(1);

    const closed = new Promise((resolve) => old.once("close", resolve));
    await closed;
    expect(await echo(fresh, "still")).toBe("still");
  });

  it("re-routes a connection whose device left before it opened", async () => {
    // A long grace, so the standby phone is still there.
    const env = await setup({ phoneMode: "fallback", timings: { drainMs: 10_000 } });
    const port = await echoServer();
    const mac = env.desktop();
    const phone = env.phone();
    await until(() => mac.role === "active" && phone.role === "standby", "the roles");
    mac.hangConnects(true);
    const pending = env.connect(port);
    await until(() => mac.lookups.length === 1, "the Mac to start opening");
    mac.instance.stop();
    const socket = await pending;
    expect(await echo(socket, "re-routed")).toBe("re-routed");
    expect(phone.lookups).toHaveLength(1);
  });

  it("goes direct in prefer, and refuses in require, when the last device leaves while opening", async () => {
    const env = await setup({ phoneMode: "off" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    mac.hangConnects(true);
    const pending = env.connect(port);
    await until(() => mac.lookups.length === 1, "the Mac to start opening");
    mac.instance.stop();
    const direct = await pending;
    expect(await echo(direct, "direct")).toBe("direct");

    await env.relay.setMode("require");
    await until(() => env.router.state.mode === "require", "botd to see require");
    await expect(env.connect(port)).rejects.toThrow("SOCKS reply 2");
    expect(env.router.state.refusedRecently).toBe(1);
    expect(env.relay.status.path).toBe("blocked");
  });

  it("releases an extra phone once it has nothing to carry", async () => {
    const env = await setup({ phoneMode: "always" });
    env.store.pair(PHONE_2_ID);
    const first = env.phone(PHONE_ID);
    await until(() => first.role === "active", "the first phone");
    const second = env.phone(PHONE_2_ID);
    await until(() => second.role === "active" && first.role === "release", "the newer phone");
  });

  it("keeps control traffic flowing to one agent while another is slow", async () => {
    const env = await setup({ phoneMode: "always" });
    const port = await echoServer();
    // A standby desktop that never reads (its socket is paused) can't hold up the phone.
    const slow = env.rawAgent({ kind: "desktop", id: "mac-0005", name: "Slow Mac" });
    await new Promise((resolve) => slow.socket.once("open", resolve));
    (slow.socket as unknown as { _socket: Socket })._socket.pause();
    const phone = env.phone();
    await until(() => phone.role === "active", "the phone");
    const socket = await env.connect(port);
    const big = "x".repeat(256 * 1024);
    expect((await echo(socket, big)).length).toBe(big.length);
  });
});
