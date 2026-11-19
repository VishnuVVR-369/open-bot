import { createHash } from "node:crypto";
import type { ModelBlobKind } from "../model-logs";

/** A distinct piece of a model request or response, stored once by its hash. */
export interface ModelBlob {
  /** SHA-256 of `content`, hex. */
  hash: string;
  kind: ModelBlobKind;
  /** The value as JSON, exactly as it is rebuilt. */
  content: string;
}

/** The SHA-256 of a text, hex: a blob's address. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * A value as a blob. It is stored as JSON in the order its keys arrived: Codex serializes the same
 * item the same way every time, so a message sent again with every request is stored once.
 */
export function modelBlob(kind: ModelBlobKind, value: unknown): ModelBlob {
  const content = JSON.stringify(value) ?? "null";
  return { hash: contentHash(content), kind, content };
}
