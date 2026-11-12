import { z } from "zod";

/**
 * Helper chats hold a swarm helper's work; they don't show in your chat lists. A teammate's inbox
 * chat is where the emails it gets arrive.
 */
export const CHAT_KINDS = ["direct", "group", "scheduled", "helper", "inbox"] as const;
export const chatKindSchema = z.enum(CHAT_KINDS);
export type ChatKind = (typeof CHAT_KINDS)[number];

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
