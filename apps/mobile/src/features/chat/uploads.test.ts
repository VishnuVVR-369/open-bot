import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ digest: vi.fn(), createTask: vi.fn(), cookie: vi.fn() }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("expo-file-system", () => ({
  File: class {
    size = 4;
    digest = native.digest;
    createUploadTask = native.createTask;
  },
  UploadType: { BINARY_CONTENT: 0 },
}));
vi.mock("../../lib/api", () => ({ api: { uploads: { status: vi.fn() } } }));
vi.mock("../../lib/auth", () => ({ sessionCookie: native.cookie }));
vi.mock("../../lib/config", () => ({ APP_URL: "http://localhost:3000" }));

import { uploadAttachment } from "./uploads";

const file = { uri: "file:///picked.txt", name: "picked.txt", mime: "text/plain", size: 4 };
beforeEach(() => {
  vi.clearAllMocks();
  native.digest.mockResolvedValue("a".repeat(64));
  native.cookie.mockResolvedValue("session=test");
});

describe("native attachment uploads", () => {
  it("reports an unreadable picked file instead of leaving its chip uploading forever", async () => {
    native.digest.mockRejectedValue(new Error("file permission was revoked"));
    const result = await uploadAttachment(file, {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });
    expect(result).toEqual({ kind: "failed", message: "Couldn't read this file. Pick it again." });
    expect(native.createTask).not.toHaveBeenCalled();
  });

  it("doesn't upload a file removed while its session headers were loading", async () => {
    const controller = new AbortController();
    native.cookie.mockImplementation(async () => {
      controller.abort();
      return "session=test";
    });
    const result = await uploadAttachment(file, { signal: controller.signal, onProgress: vi.fn() });
    expect(result).toEqual({ kind: "failed", message: "Cancelled." });
    expect(native.createTask).not.toHaveBeenCalled();
  });
});
