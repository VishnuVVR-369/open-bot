import "server-only";
import { os } from "@/lib/server/api/rpc";
import {
  confirmMemory,
  createMemory,
  forgetMemory,
  listMemories,
  memoriesForRun,
  memoryHistory,
  restoreMemory,
  updateMemory,
} from "./service";

/** What teammates remember, as the browser and the phone ask (`contract.memory`). */
export function memoryRoutes() {
  return {
    list: os.memory.list.handler(({ input }) => listMemories(input)),
    history: os.memory.history.handler(({ input }) => memoryHistory(input)),
    forRun: os.memory.forRun.handler(({ input }) => memoriesForRun(input)),
    create: os.memory.create.handler(({ input }) => createMemory(input)),
    update: os.memory.update.handler(({ input }) => updateMemory(input)),
    forget: os.memory.forget.handler(({ input }) => forgetMemory(input)),
    confirm: os.memory.confirm.handler(({ input }) => confirmMemory(input)),
    restore: os.memory.restore.handler(({ input }) => restoreMemory(input)),
  };
}
