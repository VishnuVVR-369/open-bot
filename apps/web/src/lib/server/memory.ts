import "server-only";
import { MemoryService } from "@open-bot/memory";
import { db } from "./db";

export const memory = new MemoryService(db);
