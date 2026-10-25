import { describe, it, expect } from "vitest";
import {
  memoryContext,
  memoryMarkdown,
  memoryInputSchema,
  normalizeMemory,
  hasMemorySaveIntent,
  hasMemoryForgetIntent,
  type MemoryItem,
} from "@open-bot/shared";
import { fingerprint } from "./index";
import { extractionSchema, memoryAIConfig } from "./jobs";

const item = (content: string, id = "00000000-0000-4000-8000-000000000001"): MemoryItem => ({
  id,
  botId: null,
  kind: "fact",
  content,
  key: null,
  revision: 1,
  state: "active",
  pinned: false,
  expiresAt: null,
  source: { type: "user" },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});
describe("memory contracts", () => {
  it("normalizes formatting without merging different facts", () => {
    expect(normalizeMemory("  Remote\n roles  ")).toBe("remote roles");
    expect(fingerprint("REMOTE roles")).toBe(fingerprint(" remote  roles "));
    expect(fingerprint("hybrid roles")).not.toBe(fingerprint("remote roles"));
  });
  it("bounds context and preserves source IDs without selecting partial additional items", () => {
    const packet = memoryContext(
      [item("x".repeat(10000)), item("other fact", "00000000-0000-4000-8000-000000000002")],
      500,
    );
    expect(packet.text.length).toBeLessThanOrEqual(500);
    expect(packet.refs).toEqual([{ id: item("").id, revision: 1 }]);
    expect(packet.text).toContain("…");
  });
  it("keeps Markdown portable and identifies its generated status", () => {
    expect(memoryMarkdown([item("Prefers remote roles")])).toContain("Prefers remote roles");
    expect(memoryMarkdown([])).toContain("file edits are not imported");
  });
  it("validates content and scope", () => {
    expect(memoryInputSchema.safeParse({ content: "x", botId: "anotherbot" }).success).toBe(false);
    expect(memoryInputSchema.parse({ content: "some fact" }).botId).toBeNull();
  });
  it("requires models for configured optional endpoints", () => {
    expect(() =>
      memoryAIConfig({ MEMORY_EMBEDDING_URL: "https://example.test/embeddings" }),
    ).toThrow();
    expect(memoryAIConfig({}).embeddingUrl).toBeUndefined();
    expect(() =>
      memoryAIConfig({ MEMORY_EMBEDDING_URL: "file:///secret", MEMORY_EMBEDDING_MODEL: "model" }),
    ).toThrow();
  });
  it("does not interpret forgetting or negative instructions as consent to save", () => {
    expect(hasMemorySaveIntent("Please forget I prefer remote roles")).toBe(false);
    expect(hasMemorySaveIntent("Do not remember I prefer remote roles")).toBe(false);
    expect(hasMemorySaveIntent("Please remember I prefer remote roles")).toBe(true);
    expect(hasMemoryForgetIntent("Don't forget I prefer remote roles")).toBe(false);
    expect(hasMemoryForgetIntent("Delete the temporary file")).toBe(false);
    expect(hasMemoryForgetIntent("Please delete that saved preference")).toBe(true);
  });
  it("bounds extracted facts and requires source quotes", () => {
    expect(
      extractionSchema.safeParse({ memories: [{ content: "prefers remote", kind: "preference" }] })
        .success,
    ).toBe(false);
    expect(extractionSchema.safeParse({ memories: [] }).success).toBe(true);
  });
});
