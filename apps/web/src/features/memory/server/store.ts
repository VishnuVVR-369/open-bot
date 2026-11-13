import "server-only";
import { MemoryService } from "@open-bot/memory";
import { db } from "@/lib/server/db";

export const memory = new MemoryService(db);
