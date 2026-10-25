import "server-only";
import { MemoryService } from "@open-bot/memory";
import { pool } from "./db";

const memory = new MemoryService(pool);
let imported: Promise<void> | undefined;
export async function memoryReady(): Promise<MemoryService> {
  imported ??= memory.importLegacy().catch((error) => {
    imported = undefined;
    throw error;
  });
  await imported;
  return memory;
}
