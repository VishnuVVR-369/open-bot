import { describe, expect, it } from "vitest";
import { contentHash, modelBlob } from "./model-logs";

describe("modelBlob", () => {
  it("addresses a value by the SHA-256 of its JSON", () => {
    const item = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
    const blob = modelBlob("item", item);
    expect(blob.content).toBe(JSON.stringify(item));
    expect(blob.hash).toBe(contentHash(blob.content));
    expect(blob.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(modelBlob("item", structuredClone(item)).hash).toBe(blob.hash);
    expect(JSON.parse(blob.content)).toEqual(item);
  });

  it("knows the SHA-256 of a known text", () => {
    expect(contentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
