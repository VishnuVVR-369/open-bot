import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction, as `db.transaction` passes it. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Something that runs queries: the database, or a transaction in it. */
export type Queryable = Db | Tx;
