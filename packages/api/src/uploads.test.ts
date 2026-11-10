import { describe, expect, it, vi } from "vitest";
import {
  cantAttach,
  MAX_ATTEMPTS,
  readUploadAnswer,
  uploadHeaders,
  uploadUrl,
  uploadWithRetries,
  type UploadTransport,
} from "./uploads";

const attachment = {
  name: "receipt.jpg",
  path: "/home/bot/shared/uploads/u-receipt.jpg",
  mime: "image/jpeg",
  size: 12,
};

describe("upload protocol", () => {
  it("describes the file in headers, with any name", () => {
    expect(uploadUrl("https://x.y", "u")).toBe("https://x.y/api/uploads/u");
    expect(uploadHeaders({ name: "Résumé 2.pdf", mime: "application/pdf", size: 3 }, "ab")).toEqual(
      {
        "content-type": "application/octet-stream",
        "x-upload-name": "R%C3%A9sum%C3%A9%202.pdf",
        "x-upload-mime": "application%2Fpdf",
        "x-upload-size": "3",
        "x-upload-sha256": "ab",
      },
    );
  });

  it("refuses files that are too big before uploading", () => {
    expect(cantAttach({ size: 41 * 1024 * 1024 })).toBe("Files can be up to 40 MB.");
    expect(cantAttach({ size: 1 })).toBeNull();
  });

  it("reads a finished upload", () => {
    const body = JSON.stringify({ id: "u", status: "complete", attachment });
    expect(readUploadAnswer(200, body)).toEqual({ kind: "complete", attachment });
  });

  it("retries what can go better next time, and only that", () => {
    expect(readUploadAnswer(502, "<html>Bad gateway</html>").kind).toBe("retry");
    expect(readUploadAnswer(503, JSON.stringify({ error: "down" }))).toEqual({
      kind: "retry",
      message: "down",
    });
    expect(
      readUploadAnswer(
        400,
        JSON.stringify({ error: "The file didn't arrive in one piece. Try again." }),
      ).kind,
    ).toBe("retry");
    expect(
      readUploadAnswer(
        409,
        JSON.stringify({ error: "That upload id was already used for another file." }),
      ),
    ).toEqual({
      kind: "failed",
      message: "That upload id was already used for another file.",
    });
    expect(readUploadAnswer(413, JSON.stringify({ error: "Files can be up to 40 MB." })).kind).toBe(
      "failed",
    );
    expect(readUploadAnswer(401, "{}")).toEqual({ kind: "signedOut" });
  });
});

const complete = { status: 200, body: JSON.stringify({ id: "u", status: "complete", attachment }) };

/** A transport whose sends answer in turn: an answer, null, or a throw for a request that failed. */
function transport(
  answers: ({ status: number; body: string } | null | Error)[],
  options: { arrived?: number; signal?: AbortSignal } = {},
) {
  const sent: number[] = [];
  const asked: number[] = [];
  const t: UploadTransport = {
    signal: options.signal ?? new AbortController().signal,
    sleep: async () => {},
    send: async () => {
      sent.push(sent.length);
      const answer = answers[sent.length - 1] ?? new Error("offline");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    status: async () => {
      asked.push(sent.length);
      return options.arrived !== undefined && sent.length >= options.arrived
        ? { id: "u", status: "complete", attachment }
        : null;
    },
  };
  return { t, sent, asked };
}

describe("uploading with retries", () => {
  it("sends once when the first answer is complete", async () => {
    const { t, sent, asked } = transport([complete]);
    expect(await uploadWithRetries(t)).toEqual({ kind: "complete", attachment });
    expect(sent).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it("doesn't send again when a lost answer's upload arrived after all", async () => {
    const { t, sent } = transport([new Error("connection reset")], { arrived: 1 });
    expect(await uploadWithRetries(t)).toEqual({ kind: "complete", attachment });
    expect(sent).toHaveLength(1);
  });

  it("sends again after a retryable answer, and stops at a refusal", async () => {
    const refused = { status: 413, body: JSON.stringify({ error: "Files can be up to 40 MB." }) };
    const { t, sent } = transport([{ status: 503, body: "{}" }, null, refused]);
    expect(await uploadWithRetries(t)).toEqual({
      kind: "failed",
      message: "Files can be up to 40 MB.",
    });
    expect(sent).toHaveLength(3);
  });

  it("gives up after a few attempts", async () => {
    const { t, sent } = transport([]);
    expect(await uploadWithRetries(t)).toEqual({
      kind: "failed",
      message: "The upload didn't go through. Check your connection.",
    });
    expect(sent).toHaveLength(MAX_ATTEMPTS);
  });

  it("stops when cancelled, without reporting a network failure", async () => {
    const controller = new AbortController();
    const { t, sent } = transport([], { signal: controller.signal });
    t.send = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    expect(await uploadWithRetries(t)).toEqual({ kind: "failed", message: "Cancelled." });
    expect(sent).toEqual([]);
  });
});
