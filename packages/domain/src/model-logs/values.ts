import { z } from "zod";

/** What made a logged model request: Codex on the computer, or the worker's memory AI. */
export const MODEL_REQUEST_SOURCES = ["codex", "memory"] as const;
export const modelRequestSourceSchema = z.enum(MODEL_REQUEST_SOURCES);
export type ModelRequestSource = (typeof MODEL_REQUEST_SOURCES)[number];

/**
 * The model proxy's routes, each a fixed upstream: `plan` is ChatGPT's Codex backend with the
 * computer's own login, `api` the OpenAI API with the key the worker adds.
 */
export const MODEL_ROUTES = ["plan", "api"] as const;
export const modelRouteSchema = z.enum(MODEL_ROUTES);
export type ModelRoute = (typeof MODEL_ROUTES)[number];

/** How a request reached the model: one HTTP request, or a message on a WebSocket. */
export const MODEL_TRANSPORTS = ["http", "websocket"] as const;
export const modelTransportSchema = z.enum(MODEL_TRANSPORTS);
export type ModelTransport = (typeof MODEL_TRANSPORTS)[number];

/** Which side of a request an item is on: what was sent, or what the model answered. */
export const MODEL_ITEM_SIDES = ["input", "output"] as const;
export const modelItemSideSchema = z.enum(MODEL_ITEM_SIDES);
export type ModelItemSide = (typeof MODEL_ITEM_SIDES)[number];

/** What a stored blob holds: one input or output item, the instructions, or the tool list. */
export const MODEL_BLOB_KINDS = ["item", "instructions", "tools"] as const;
export const modelBlobKindSchema = z.enum(MODEL_BLOB_KINDS);
export type ModelBlobKind = (typeof MODEL_BLOB_KINDS)[number];
