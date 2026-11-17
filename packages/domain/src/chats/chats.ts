import { z } from "zod";

/**
 * Helper chats hold a swarm helper's work; they don't show in your chat lists. Scheduled and inbox chats
 * keep historical runs; new automation and email work arrives in the main direct chat.
 */
export const CHAT_KINDS = ["direct", "group", "scheduled", "helper", "inbox"] as const;
export const chatKindSchema = z.enum(CHAT_KINDS);
export type ChatKind = (typeof CHAT_KINDS)[number];

/** A conversation or independent line of automated work within a chat. */
export const runLaneSchema = z.union([
  z.literal("chat"),
  z.literal("inbox"),
  z.templateLiteral(["schedule:", z.string().uuid()]),
  z.templateLiteral(["trigger:", z.string().uuid()]),
]);
export type RunLane = z.infer<typeof runLaneSchema>;

/** Who wrote a message: you, or the app (like a note that a teammate joined). */
export const MESSAGE_ROLES = ["user", "system"] as const;
export const messageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Your thumbs up or down on a reply. */
export const RUN_RATINGS = ["up", "down"] as const;
export const runRatingSchema = z.enum(RUN_RATINGS);
export type RunRating = (typeof RUN_RATINGS)[number];

/** An attachment upload: still arriving, written to the computer, or given up on. */
export const UPLOAD_STATUSES = ["writing", "complete", "failed"] as const;
export const uploadStatusSchema = z.enum(UPLOAD_STATUSES);
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];
