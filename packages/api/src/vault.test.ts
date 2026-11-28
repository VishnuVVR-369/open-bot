import { describe, expect, it } from "vitest";
import { vaultItemCreateSchema, vaultItemPatchSchema } from "./vault";

const itemId = "00000000-0000-4000-8000-000000000001";

describe("a vault patch", () => {
  const problem = (patch: object) =>
    vaultItemPatchSchema.safeParse({ itemId, ...patch }).error?.issues.map((i) => i.message);

  it("needs something to change", () => {
    expect(problem({})).toEqual(["Say what to change."]);
    expect(problem({ secret: {} })).toEqual(["Say what to change."]);
    // Empty secret fields keep what's saved, so a patch of only those changes nothing.
    expect(problem({ secret: { password: "" } })).toEqual(["Say what to change."]);
    expect(problem({ secret: { number: "  ", cvc: "" } })).toEqual(["Say what to change."]);
  });

  it("counts a new secret, any other field, and a cleared username", () => {
    expect(problem({ secret: { password: "made-up-pass" } })).toBeUndefined();
    expect(problem({ secret: { password: "", zip: "10115" } })).toBeUndefined();
    // An empty username clears it, which the worker refuses with its own words.
    expect(problem({ secret: { username: "" } })).toBeUndefined();
    expect(problem({ name: "GitHub" })).toBeUndefined();
    expect(problem({ teammateIds: null })).toBeUndefined();
  });
});

describe("a new vault item", () => {
  it("is made under a client's id", () => {
    const item = { kind: "login", name: "GitHub", domain: "github.com", teammateIds: null };
    expect(vaultItemCreateSchema.safeParse({ ...item, id: itemId, secret: {} }).success).toBe(true);
    expect(vaultItemCreateSchema.safeParse({ ...item, secret: {} }).success).toBe(false);
    expect(vaultItemCreateSchema.safeParse({ ...item, id: "x", secret: {} }).success).toBe(false);
  });
});
