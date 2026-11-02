import "server-only";
import { API_ERRORS, contract } from "@open-bot/api";
import { implement, ORPCError } from "@orpc/server";
import { z } from "zod";
import { auth } from "../auth";
import { listBots, listChats, getChatData, listApprovals } from "../queries";
import { WorkerError } from "../worker";
import { decideApproval, getApproval } from "./approvals";
import { newDirectChat, sendMessage } from "./chats";
import { ApiError } from "./errors";
import { registerPushDevice, sendTestPush, unregisterPushDevice } from "./push";

export interface RpcContext {
  headers: Headers;
}

const WORKER_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  503: "SERVICE_UNAVAILABLE",
};

/** Errors as callers see them: the same messages the web shows, with a code to act on. */
function toRpcError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) return error;
  if (error instanceof ApiError) {
    // A defined error only counts as one with the status the contract gives it.
    const status = error.code === "BAD_REQUEST" ? 400 : API_ERRORS[error.code].status;
    return new ORPCError(error.code, {
      status,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    });
  }
  if (error instanceof z.ZodError)
    return new ORPCError("BAD_REQUEST", { message: error.issues.map((i) => i.message).join(". ") });
  if (error instanceof WorkerError) {
    const code = WORKER_CODES[error.status] ?? "INTERNAL_SERVER_ERROR";
    // A worker 409 is a state conflict, not a reused id: don't let it pass as the defined CONFLICT.
    return new ORPCError(code === "CONFLICT" ? "STATE_CONFLICT" : code, {
      status: error.status,
      message: error.message,
    });
  }
  console.error("rpc failed", error);
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    message: error instanceof Error ? error.message : String(error),
  });
}

const os = implement(contract)
  .$context<RpcContext>()
  .use(async ({ context, next }) => {
    const session = await auth.api.getSession({ headers: context.headers });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
    try {
      return await next({ context: { user: session.user } });
    } catch (error) {
      throw toRpcError(error);
    }
  });

export const router = os.router({
  teammates: {
    list: os.teammates.list.handler(() => listBots()),
  },
  chats: {
    list: os.chats.list.handler(() => listChats()),
    get: os.chats.get.handler(async ({ input }) => {
      const data = await getChatData(input.chatId, input.before);
      if (!data) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
      return data;
    }),
    newDirect: os.chats.newDirect.handler(({ input }) => newDirectChat(input)),
    send: os.chats.send.handler(({ input }) => sendMessage(input)),
  },
  approvals: {
    list: os.approvals.list.handler(() => listApprovals()),
    get: os.approvals.get.handler(({ input }) => getApproval(input.approvalId)),
    decide: os.approvals.decide.handler(({ input }) => decideApproval(input)),
  },
  push: {
    registerDevice: os.push.registerDevice.handler(({ input }) => registerPushDevice(input)),
    unregisterDevice: os.push.unregisterDevice.handler(({ input }) => unregisterPushDevice(input)),
    test: os.push.test.handler(() => sendTestPush()),
  },
});
