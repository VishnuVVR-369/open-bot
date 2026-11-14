import { describe, expect, it } from "vitest";
import { computerPageFiles } from "./service";

/** Page files whose Codex file API fails every request with `message`. */
function failingWith(message: string) {
  const codex = {
    ready: async () => ({
      request: async () => {
        throw new Error(message);
      },
    }),
  };
  return computerPageFiles({ codex } as unknown as Parameters<typeof computerPageFiles>[0]);
}

describe("a page's file on the computer", () => {
  it("reads as nothing when it isn't there", async () => {
    await expect(
      failingWith("No such file or directory (os error 2)").read("/a.html"),
    ).resolves.toBeNull();
  });

  it("passes on any other failure, so a restore never writes over a file it couldn't read", async () => {
    await expect(failingWith("request timed out").read("/a.html")).rejects.toThrow(
      "request timed out",
    );
  });
});
