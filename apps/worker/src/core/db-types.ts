import type { schema } from "@open-bot/db";

// Rows the worker passes between runs, services and tools. They live here, not with any one of
// them, so a module can take a teammate or a run without importing the module that runs it.

export type Bot = typeof schema.bots.$inferSelect;
export type Chat = typeof schema.chats.$inferSelect;
export type Run = typeof schema.runs.$inferSelect;
