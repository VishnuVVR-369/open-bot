import { createHash } from "node:crypto";

/** JSON with object keys sorted, so equal values always serialise the same way. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

const canonicalJson = (value: unknown) => JSON.stringify(canonical(value));

/**
 * An opaque revision for saved configuration (a teammate, a connection, a tool call). Key order
 * and omitted fields don't change it, and it never reveals the data it was made from.
 */
export function configurationRevision(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Whether two values are the same JSON, the way a `jsonb` column sees them. Postgres doesn't keep
 * object key order (it sorts keys by length, then bytes), so a value read back from `jsonb` never
 * matches what was written by `JSON.stringify`. Key order and `undefined` fields don't count here;
 * array order does, and a `Date` is its ISO string, as it was when saved.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
