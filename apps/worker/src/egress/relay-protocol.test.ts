// The egress relay holding to the tunnel protocol with misbehaving, old and silent agents, and
// across a computer reconnect.
import { AGENT_GONE, decodeFrame, encodeFrame, FrameType } from "@open-bot/egress";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, echo, echoServer, setup, until } from "./relay.testing";

afterEach(cleanUp);

describe("egress relay", () => {
  it("answers AGENT_GONE when no device is connected", async () => {
    const env = await setup();
    // Speak to the relay as a computer would, on the tunnel botd holds.
    const tunnel = env.tunnels[0]!;
    const answers: { type: number; reason: string }[] = [];
    tunnel.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(data as Buffer);
      answers.push({ type: frame.type, reason: frame.payload.toString() });
    });
    tunnel.send(encodeFrame(FrameType.Open, 1001, JSON.stringify({ host: "x", port: 1 })));
    await until(() => answers.length === 1, "the answer");
    expect(answers).toEqual([{ type: FrameType.OpenFail, reason: AGENT_GONE }]);
  });

  it("drops frames from an agent for streams it doesn't own", async () => {
    const env = await setup({ phoneMode: "fallback" });
    const port = await echoServer();
    const mac = env.desktop();
    await until(() => mac.role === "active", "the Mac to be active");
    const intruder = env.rawAgent({ kind: "desktop", id: "mac-0002-old", name: "Old Mac" });
    // The newest desktop wins; let the original one win again by reconnecting it.
    await until(() => intruder.texts.some((m) => m.type === "role"), "the intruder's role");
    mac.instance.stop();
    mac.instance.start();
    await until(() => mac.role === "active" && mac.roles.length >= 2, "the Mac back");
    const socket = await env.connect(port);
    // Stream 1 is the Mac's; the standby agent can't touch it, and gets a reset for its data.
    intruder.socket.send(encodeFrame(FrameType.Data, 1, "injected"));
    intruder.socket.send(encodeFrame(FrameType.Reset, 1));
    await until(() => intruder.frames.length === 1, "the intruder's reset");
    expect(decodeFrame(intruder.frames[0]!).type).toBe(FrameType.Reset);
    expect(await echo(socket, "untouched")).toBe("untouched");
  });

  it("starts a new generation when the computer reconnects; late frames from before go nowhere", async () => {
    // In require, the connection that was opening is refused rather than sent direct.
    const env = await setup({ mode: "require", phoneMode: "off" });
    const port = await echoServer();
    const raw = env.rawAgent({ kind: "desktop", id: "mac-0003", name: "Mac" });
    await until(() => raw.texts.some((m) => m.type === "role" && m.role === "active"), "active");
    await until(() => env.router.state.agentOnline, "botd to see the device");
    const pending = env.connect(port).catch((error: Error) => error);
    await until(() => raw.frames.length === 1, "the open");
    const open = decodeFrame(raw.frames[0]!);
    expect(open.type).toBe(FrameType.Open);

    env.tunnels[0]!.terminate();
    await until(() => raw.texts.some((m) => m.type === "peer-down"), "peer-down");
    await until(() => env.tunnels.length === 2 && env.relay.computerConnected, "the new tunnel");
    // A late answer for the old stream: the relay forgot it, so it reaches nothing.
    raw.socket.send(encodeFrame(FrameType.OpenFail, open.streamId, "too late"));
    raw.socket.send(encodeFrame(FrameType.Data, open.streamId, "late"));
    await until(() => raw.frames.length === 2, "the reset for late data");
    expect(decodeFrame(raw.frames[1]!).type).toBe(FrameType.Reset);
    expect(await pending).toBeInstanceOf(Error);
  });

  it("treats an agent that ignores role messages as a working desktop", async () => {
    const env = await setup({ phoneMode: "off" });
    const raw = env.rawAgent({ kind: "desktop", id: "desktop", name: "Desktop app" });
    await until(() => env.relay.status.agentOnline, "the legacy agent");
    expect(env.relay.status.agents).toMatchObject([{ id: "desktop", role: "active" }]);
    // The relay counts the agent online when it sends the role; the agent reads it a moment later.
    await until(() => raw.texts.some((m) => m.type === "role"), "the role message");
  });

  it("terminates an agent that stops answering pings", async () => {
    const env = await setup();
    const raw = env.rawAgent({ kind: "desktop", id: "mac-0004", name: "Mac" }, { autoPong: false });
    await until(() => env.relay.status.agentOnline, "the agent");
    const closed = new Promise((resolve) => raw.socket.once("close", resolve));
    await closed;
    expect(env.relay.status.agentOnline).toBe(false);
  });
});
