import { describe, expect, it } from "vitest";
import { cantAttach, readUploadAnswer, uploadHeaders, uploadUrl } from "./upload-protocol";

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
