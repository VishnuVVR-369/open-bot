import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb, createPool, errorFields } from "./index";

const pool = createPool(
  process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  // The migration's own query fails with it too, and that ends the run.
  { onIdleError: (error) => console.error("database connection failed", errorFields(error)) },
);
await migrate(createDb(pool), {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
await pool.end();
console.log("Migrations applied");
