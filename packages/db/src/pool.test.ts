import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPool } from "./index";

describe("createPool", () => {
  it("hands an idle connection's error to onIdleError without its values", async () => {
    const errors: Error[] = [];
    // Nothing connects until a query, so the address is never reached.
    const pool = createPool("postgres://unused@127.0.0.1:1/unused", {
      onIdleError: (error) => errors.push(error),
    });
    const failed = Object.assign(
      new pg.DatabaseError('invalid input syntax for type integer: "Private Name"', 0, "error"),
      { code: "22P02", detail: "Private detail" },
    );

    // What the pool does when a connection it holds fails. Without a listener this would throw.
    expect(pool.emit("error", failed, {} as pg.PoolClient)).toBe(true);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("The database refused the query (SQLSTATE 22P02).");
    expect((errors[0] as pg.DatabaseError).detail).toBeUndefined();
    await pool.end();
  });
});
