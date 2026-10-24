import "server-only";
import { createDb, createPool, type Db } from "@open-bot/db";
import type pg from "pg";
import { serverEnv } from "./env";

// One pool per server process, reused across hot reloads in development.
const globalForDb = globalThis as unknown as { openbotPool?: pg.Pool; openbotDb?: Db };

export const pool = (globalForDb.openbotPool ??= createPool(serverEnv.databaseUrl));
export const db = (globalForDb.openbotDb ??= createDb(pool));
