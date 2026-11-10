import { MAX_UPLOAD_BYTES } from "@open-bot/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/session", () => ({ sessionOrNull: async () => ({ user: { id: "owner" } }) }));
vi.mock("@/lib/server/auth-config", () => ({ TRUSTED_ORIGINS: ["https://app.test"] }));
vi.mock("@/lib/server/worker", () => ({
  WorkerError: class extends Error {},
  worker: { files: { put } },
}));

const { PUT } = await import("./route");

function upload(
  body: BodyInit | null,
  { dir = "/home/notes", name = "plan%20v2.md" }: { dir?: string; name?: string } = {},
  headers: Record<string, string> = {},
): Request {
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  return new Request(`https://app.test/api/files/upload${query}`, {
    method: "PUT",
    headers: { host: "app.test", origin: "https://app.test", "x-upload-name": name, ...headers },
    body,
    // @ts-expect-error Node needs it for a streamed body.
    duplex: "half",
  });
}

/** A body that keeps sending until it's read past `bytes`, and says whether it was cancelled. */
function endless(bytes: number) {
  let sent = 0;
  const state = { cancelled: false, sent: () => sent };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > bytes) return controller.close();
      const chunk = new Uint8Array(1024 * 1024);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({ path: "/home/notes/plan v2.md" });
});

describe("PUT /api/files/upload", () => {
  it("puts the file into the folder under its decoded name", async () => {
    const response = await PUT(upload("# Plan"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/home/notes/plan v2.md" });
    expect(put).toHaveBeenCalledWith(
      {
        dir: "/home/notes",
        name: "plan v2.md",
        dataBase64: Buffer.from("# Plan").toString("base64"),
      },
      { context: { timeoutMs: 120_000 } },
    );
  });

  it("refuses a request without a folder or a name", async () => {
    for (const request of [
      upload("x", { dir: "" }),
      upload("x", { name: "" }),
      upload("x", { name: "%E0%A4%A" }),
    ]) {
      const response = await PUT(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Say which folder and file name." });
    }
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a file said to be too big before reading it", async () => {
    const { stream, state } = endless(0);
    const response = await PUT(
      upload(stream, {}, { "content-length": String(MAX_UPLOAD_BYTES + 1) }),
    );
    expect(response.status).toBe(413);
    expect(state.sent()).toBeLessThanOrEqual(1024 * 1024);
    expect(put).not.toHaveBeenCalled();
  });

  it("stops reading a file that turns out too big", async () => {
    const { stream, state } = endless(MAX_UPLOAD_BYTES * 2);
    const response = await PUT(upload(stream));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Files can be up to 40 MB." });
    expect(state.cancelled).toBe(true);
    expect(state.sent()).toBeLessThan(MAX_UPLOAD_BYTES + 3 * 1024 * 1024);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a write from another site", async () => {
    const response = await PUT(upload("x", {}, { origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });
});
