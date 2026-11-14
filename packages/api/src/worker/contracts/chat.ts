import { base, id, ok } from "../base";
import { runRatingSchema } from "@open-bot/domain";
import { z } from "zod";
import {
  chatTitleSchema,
  feedbackInputSchema,
  groupTeammatesSchema,
  sendMessageInputSchema,
} from "../../contracts/chat";
import { messageViewSchema } from "../../views";

export const chatsContract = {
  /** Start a new direct chat with a teammate. */
  newDirect: base
    .route({ method: "POST", path: "/internal/chats/direct" })
    .input(z.object({ teammateId: id }))
    .output(z.object({ chatId: z.string() })),
  /** Start a group chat with two or more teammates. */
  createGroup: base
    .route({ method: "POST", path: "/internal/chats/group" })
    .input(z.object({ title: chatTitleSchema, teammateIds: groupTeammatesSchema }))
    .output(z.object({ chatId: z.string() })),
  rename: base
    .route({ method: "POST", path: "/internal/chats/{chatId}/rename" })
    .input(z.object({ chatId: id, title: chatTitleSchema }))
    .output(ok),
  /** Hide a chat from the lists. Its history stays. */
  archive: base
    .route({ method: "POST", path: "/internal/chats/{chatId}/archive" })
    .input(z.object({ chatId: id }))
    .output(ok),
  /** Make a direct chat its teammate's main chat. 400 for a group or an archived chat. */
  makeMain: base
    .route({ method: "POST", path: "/internal/chats/{chatId}/main" })
    .input(z.object({ chatId: id }))
    .output(ok),
  /** The owner has seen what's in the chat. */
  markRead: base
    .route({ method: "POST", path: "/internal/chats/{chatId}/read" })
    .input(z.object({ chatId: id }))
    .output(ok),
  /**
   * Save a message the owner sent and deliver it. 409 when its `clientId` was used for a
   * different message; the same message again returns it and delivers it again.
   */
  send: base
    .route({ method: "POST", path: "/internal/chats/{chatId}/messages" })
    .input(sendMessageInputSchema)
    .output(messageViewSchema),
};

export const messagesContract = {
  /** Deliver a saved message to the teammates it is for. Safe to call again. */
  dispatch: base
    .route({ method: "POST", path: "/internal/messages/{messageId}/dispatch" })
    .input(z.object({ messageId: id }))
    .output(ok),
};

export const runsContract = {
  /** Run a finished run's request again; asked again after that, it returns the new run. */
  retry: base
    .route({ method: "POST", path: "/internal/runs/{runId}/retry" })
    .input(z.object({ runId: id }))
    .output(z.object({ runId: z.string() })),
  /** Stop the runs the owner marked as cancelled in the database. */
  processCancellations: base.route({ method: "POST", path: "/internal/runs/cancel" }).output(ok),
  /** Stop a run. */
  stop: base
    .route({ method: "POST", path: "/internal/runs/{runId}/stop" })
    .input(z.object({ runId: id }))
    .output(ok),
  rate: base
    .route({ method: "POST", path: "/internal/runs/{runId}/rate" })
    .input(z.object({ runId: id, rating: runRatingSchema.nullable() }))
    .output(ok),
  /**
   * A thumbs down with what to change: kept as a lesson with `remember`, and with `redo` sent to
   * the chat as a new message. 409 when the redo's `clientId` was used for something else.
   */
  feedback: base
    .route({ method: "POST", path: "/internal/runs/{runId}/feedback" })
    .input(feedbackInputSchema)
    .output(ok),
};

export const swarmsContract = {
  /** Stop every helper in a swarm. */
  stop: base
    .route({ method: "POST", path: "/internal/swarms/{swarmId}/stop" })
    .input(z.object({ swarmId: id }))
    .output(ok),
};
