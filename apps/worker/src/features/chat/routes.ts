import { os } from "../../core/rpc";
import type { ChatService } from "./service";

const ok = { ok: true } as const;

/** Chats and the messages you send, as the web app changes them (`workerContract.chats`). */
export function chatRoutes(chats: ChatService) {
  return {
    newDirect: os.chats.newDirect.handler(({ input }) => chats.newDirect(input.teammateId)),
    createGroup: os.chats.createGroup.handler(({ input }) =>
      chats.createGroup(input.title, input.teammateIds),
    ),
    rename: os.chats.rename.handler(async ({ input }) => {
      await chats.rename(input.chatId, input.title);
      return ok;
    }),
    makeMain: os.chats.makeMain.handler(async ({ input }) => {
      await chats.makeMain(input.chatId);
      return ok;
    }),
    archive: os.chats.archive.handler(async ({ input }) => {
      await chats.archive(input.chatId);
      return ok;
    }),
    markRead: os.chats.markRead.handler(async ({ input }) => {
      await chats.markRead(input.chatId);
      return ok;
    }),
    send: os.chats.send.handler(({ input }) => chats.send(input)),
  };
}
