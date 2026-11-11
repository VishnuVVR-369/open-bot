import { MemoryError } from "@open-bot/memory";
import { ORPCError, ValidationError } from "@orpc/server";
import { errorMessage } from "../logger";
import { UploadError } from "../uploads";
import { ApprovalError } from "../services/approvals";
import { BotError } from "../services/bots";
import { ChatError } from "../services/chats";
import { RunError } from "../runs/requests";
import { EmailError } from "../services/email";
import { FileError } from "../services/files";
import { PageError } from "../services/pages";
import { PushError } from "../services/push";
import { RetryError } from "../services/retries";
import { ScheduleError } from "../services/schedules";
import { ScreenBusy } from "../services/screen-lock";
import { SettingsError } from "../services/settings";
import { SkillError } from "../services/skills";
import { TaskError } from "../services/tasks";
import { TelegramError } from "../services/telegram";
import { TriggerError } from "../services/triggers";

/** The code each status a procedure fails with is sent as, next to the message. */
const CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

/** Fail a procedure with a status and a message for the owner. */
export function rpcError(status: number, message: string): ORPCError<string, undefined> {
  return new ORPCError(CODES[status] ?? CODES[500]!, { status, message });
}

/** Services' errors whose message is for the owner: a request the service can't do as asked. */
const BAD_REQUESTS = [
  PageError,
  PushError,
  ScheduleError,
  SettingsError,
  SkillError,
  TaskError,
  TelegramError,
  TriggerError,
] as const;

/**
 * Every error a procedure throws, as the status and message the caller sees. This is the only
 * place a service's error becomes an HTTP status.
 */
export function toRpcError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    // Input that doesn't fit the contract: say what's wrong, as the schema words it.
    if (error.cause instanceof ValidationError && error.code === "BAD_REQUEST")
      return rpcError(400, error.cause.issues.map((issue) => issue.message).join("; "));
    return error;
  }
  if (
    error instanceof ApprovalError ||
    error instanceof BotError ||
    error instanceof ChatError ||
    error instanceof RunError ||
    error instanceof FileError ||
    error instanceof MemoryError ||
    error instanceof RetryError ||
    error instanceof UploadError
  )
    return rpcError(error.status, error.message);
  if (error instanceof ScreenBusy) return rpcError(409, error.message);
  // An inbound address that isn't one: nothing more is said about why.
  if (error instanceof EmailError) return rpcError(404, "Not found.");
  if (BAD_REQUESTS.some((type) => error instanceof type)) return rpcError(400, errorMessage(error));
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    status: 500,
    message: errorMessage(error),
    cause: error,
  });
}

/**
 * What a procedure whose input carries a secret (a one-time code) says instead: its errors, even
 * a validation message, could repeat part of the input.
 */
export function maskedError(error: ORPCError<string, unknown>): ORPCError<string, undefined> {
  return error.status === 400
    ? rpcError(400, "That code request is invalid. Nothing was typed.")
    : rpcError(500, "Code entry outcome unknown. Check the screen.");
}
