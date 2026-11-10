import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the server's realtime hub. Its Postgres connection answers when the test says,
 * and `waiting` settles once a request is waiting for it.
 */
function standInHub() {
  let connected = () => {};
  let asked = () => {};
  const ready = new Promise<void>((resolve) => (connected = resolve));
  const waiting = new Promise<void>((resolve) => (asked = resolve));
  const standIn = Object.assign(new EventEmitter(), {
    stopping: false,
    shutdown: () => {
      standIn.stopping = true;
      standIn.emit("shutdown");
    },
    ensure: () => {
      asked();
      return ready;
    },
    connected: () => connected(),
    waiting,
  });
  return standIn;
}

const hub = vi.hoisted(() => ({ current: null as unknown }));
const current = () => hub.current as ReturnType<typeof standInHub>;

vi.mock("@/lib/server/session", () => ({ sessionOrNull: async () => ({ user: { id: "owner" } }) }));
vi.mock("@/lib/server/db", () => ({ db: {} }));
vi.mock("@/lib/server/realtime", () => ({
  get realtime() {
    return hub.current;
  },
}));

const request = () => new Request("http://app.test/api/stream");

describe("the event stream while the server stops", () => {
  beforeEach(() => {
    hub.current = standInHub();
  });

  it("ends an open stream, telling the tab to come back soon", async () => {
    const { GET } = await import("./route");
    current().connected();
    const response = await GET(request());
    current().shutdown();
    expect(await response.text()).toMatch(/^event: ready\n.*\n\nretry: 1000\n\n$/);
    expect(current().listenerCount("shutdown")).toBe(0);
  });

  it("turns away a stream that was still waiting for Postgres when stopping began", async () => {
    const { GET } = await import("./route");
    const pending = GET(request());
    await current().waiting;
    current().shutdown();
    current().connected();
    const response = await pending;
    expect(response.headers.get("connection")).toBe("close");
    expect(current().listenerCount("shutdown")).toBe(0);
    expect(current().listenerCount("app")).toBe(0);
    expect(await response.text()).toBe("retry: 1000\n\n");
  });

  it("turns away new streams once stopping", async () => {
    const { GET } = await import("./route");
    current().shutdown();
    const response = await GET(request());
    expect(await response.text()).toBe("retry: 1000\n\n");
  });
});
