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

/** What a teammate's revision covers: the profile the owner and the teammates edit. */
interface TeammateProfileFields {
  name: string;
  role: string;
  instructions: string;
  color: string;
  emoji: string;
  autonomy: string;
}

/**
 * A teammate's revision: its profile only, so a save from a stale copy is refused when someone
 * changed the profile meanwhile, and not when something else on the row did (its budget, being
 * made the lead, a lesson it learned). The worker checks it, and the web app hands it out.
 */
export function teammateRevision({
  name,
  role,
  instructions,
  color,
  emoji,
  autonomy,
}: TeammateProfileFields): string {
  return configurationRevision({ name, role, instructions, color, emoji, autonomy });
}
