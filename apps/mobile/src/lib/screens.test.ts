import { describe, expect, it, vi } from "vitest";
import { recoverCodeOperation } from "./screens";

describe("code recovery", () => {
  it("reads an existing operation without repeating input or cancelling it", async () => {
    const cancel = vi.fn();
    const result = { status: "typing" };
    expect(await recoverCodeOperation("id", async () => result, cancel)).toBe(result);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("inserts a cancellation tombstone when the request has not appeared", async () => {
    const cancel = vi.fn(async () => ({ status: "cancelled" }));
    expect(await recoverCodeOperation("id", async () => null, cancel)).toEqual({
      status: "cancelled",
    });
    expect(cancel).toHaveBeenCalledWith("id");
  });
  it("propagates unreachable status as unknown without cancelling or typing", async () => {
    const cancel = vi.fn();
    await expect(
      recoverCodeOperation(
        "id",
        async () => {
          throw new Error("offline");
        },
        cancel,
      ),
    ).rejects.toThrow("offline");
    expect(cancel).not.toHaveBeenCalled();
  });
});
