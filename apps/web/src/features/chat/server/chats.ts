import "server-only";
import type { ApiInputs, MessageView } from "@open-bot/api";
import { worker, WorkerError } from "@/lib/server/worker";
import { ApiError } from "@/lib/server/api/errors";

/**
 * Your changes to chats and the messages you send. The worker's chat service makes them (it owns
 * those tables, see packages/db/src/owners.ts).
 */

type Inputs = ApiInputs["chats"];

/** The worker's 409 for a reused message id is the contract's `CONFLICT`. */
export async function reusedId<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof WorkerError && error.status === 409)
      throw new ApiError("CONFLICT", error.message);
    throw error;
  }
}

export function newDirectChat({
  teammateId: botId,
}: Inputs["newDirect"]): Promise<{ chatId: string }> {
  return worker.chats.newDirect({ teammateId: botId });
}

export function createGroupChat({ title, teammateIds: botIds }: Inputs["createGroup"]) {
  return worker.chats.createGroup({ title, teammateIds: botIds });
}

export function renameChat({ chatId, title }: Inputs["rename"]) {
  return worker.chats.rename({ chatId, title });
}

export function archiveChat({ chatId }: Inputs["archive"]) {
  return worker.chats.archive({ chatId });
}

/** Make a chat with one teammate its main chat. */
export function makeMainChat({ chatId }: Inputs["makeMain"]) {
  return worker.chats.makeMain({ chatId });
}

/** You've seen the chat: what teammates said in it isn't unread anymore, on any device. */
export function markChatRead({ chatId }: Inputs["markRead"]) {
  return worker.chats.markRead({ chatId });
}

/**
 * Send a message. The worker saves it and delivers it; a retry with the same client id returns the
 * saved message.
 */
export function sendMessage(input: Inputs["send"]): Promise<MessageView> {
  return reusedId(worker.chats.send(input));
}
