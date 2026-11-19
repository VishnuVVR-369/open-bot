import { RpcError } from "@open-bot/agent";
import { describe, expect, it } from "vitest";
import { isMissingPath } from "./files";

// The messages Codex 0.162.1's `fs/readDirectory` and `fs/readFile` answer with (code -32603).
describe("isMissingPath", () => {
  it("is true for a path that isn't there", () => {
    expect(isMissingPath(new RpcError(-32603, "No such file or directory (os error 2)"))).toBe(
      true,
    );
  });

  it("is false for every other failure", () => {
    for (const error of [
      new RpcError(-32603, "Not a directory (os error 20)"),
      new RpcError(-32603, "Permission denied (os error 13)"),
      new RpcError(-32601, "Method not found"),
      new Error("Codex request fs/readDirectory timed out"),
      new Error("Codex connection is closed"),
    ])
      expect(isMissingPath(error)).toBe(false);
  });
});
