import "server-only";
import { uploadStatus } from "./uploads";
import { ApiError } from "@/lib/server/api/errors";
import { os } from "@/lib/server/api/rpc";
import {
  archiveChat,
  createGroupChat,
  makeMainChat,
  markChatRead,
  newDirectChat,
  renameChat,
  sendMessage,
} from "./chats";
import { listChats } from "./lists";
import { getChatData, searchMessages } from "./queries";
import { cancelRun, giveFeedback, rateRun, retryRun, stopSwarm } from "./runs";

/**
 * Chats, the runs in them and their swarms, and searching messages, as the browser and the phone
 * ask (`contract.chats`, `contract.runs`, `contract.swarms` and `contract.search`).
 */
export function chatRoutes() {
  return {
    uploads: {
      status: os.uploads.status.handler(({ input }) => uploadStatus(input.uploadId)),
    },
    chats: {
      list: os.chats.list.handler(() => listChats()),
      get: os.chats.get.handler(async ({ input }) => {
        const data = await getChatData(input.chatId, input.before);
        if (!data) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
        return data;
      }),
      newDirect: os.chats.newDirect.handler(({ input }) => newDirectChat(input)),
      createGroup: os.chats.createGroup.handler(({ input }) => createGroupChat(input)),
      rename: os.chats.rename.handler(({ input }) => renameChat(input)),
      archive: os.chats.archive.handler(({ input }) => archiveChat(input)),
      makeMain: os.chats.makeMain.handler(({ input }) => makeMainChat(input)),
      markRead: os.chats.markRead.handler(({ input }) => markChatRead(input)),
      send: os.chats.send.handler(({ input }) => sendMessage(input)),
    },
    runs: {
      retry: os.runs.retry.handler(({ input }) => retryRun(input)),
      cancel: os.runs.cancel.handler(({ input }) => cancelRun(input)),
      rate: os.runs.rate.handler(({ input }) => rateRun(input)),
      feedback: os.runs.feedback.handler(({ input }) => giveFeedback(input)),
    },
    swarms: {
      stop: os.swarms.stop.handler(({ input }) => stopSwarm(input)),
    },
    search: {
      messages: os.search.messages.handler(({ input }) => searchMessages(input.query)),
    },
  };
}
