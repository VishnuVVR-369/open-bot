// Column types and helpers the schema files share. Not part of the package's exports.
import { type AnyPgColumn, customType, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** A check that a text column holds one of the values its domain type lists. */
export const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(","))})`;

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Derived vectors are fenced by model and dimensions; they can be rebuilt independently. */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
});
