import { createORPCClient, ORPCError } from "@orpc/client";
import { type ContractRouterClient, ValidationError } from "@orpc/contract";
import { ResponseValidationPlugin } from "@orpc/contract/plugins";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { type BotdContract, type BotdMeta, botdContract } from "./contract";

/** Per call: `botd.pages.check(input, { context: { timeoutMs: 90_000 } })`. */
export interface BotdCallContext {
  /** Give up after this long. Defaults to `BotdClientOptions.timeoutMs`. */
  timeoutMs?: number;
}

export type BotdClient = ContractRouterClient<BotdContract, BotdCallContext>;

/** A procedure being called, as `BotdClientOptions.around` sees it. */
export interface BotdCall {
  meta: BotdMeta;
  /** Its HTTP path, like `/computer/action`. */
  path: string;
}

export interface BotdClientOptions {
  /** Where botd is, like `http://computer.railway.internal:8090`. */
  url: string;
  /** `BOTD_TOKEN`, sent as a bearer token. */
  token: string;
  /** How long a call may take unless it says otherwise. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** An extra signal for a call, read when it is sent, like one that stops calls at shutdown. */
  signal?: () => AbortSignal | undefined;
  /** Runs around every call, such as waking the computer for one that needs it. */
  around?: <T>(call: BotdCall, next: () => Promise<T>) => Promise<T>;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

/** botd answered with an error status, or with an answer the contract doesn't allow (502). */
export class BotdError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`botd ${path} returned ${status}: ${detail}`);
    this.name = "BotdError";
  }
}

/** The contract procedure at a client path, like `["computer", "action"]`. */
function procedureAt(path: readonly string[]): BotdCall {
  let node: unknown = botdContract;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  const orpc = (node as { "~orpc": { meta: BotdMeta; route: { path?: string } } })["~orpc"];
  return { meta: orpc.meta, path: orpc.route.path ?? `/${path.join("/")}` };
}

/**
 * A typed client for botd. Every answer is checked against the contract. Errors are `BotdError`s
 * with botd's status and message; a botd that can't be reached, or doesn't answer in time, throws
 * the fetch error.
 */
export function createBotdClient(options: BotdClientOptions): BotdClient {
  const send = options.fetch ?? fetch;
  const link = new OpenAPILink<BotdCallContext>(botdContract, {
    url: options.url.replace(/\/+$/, ""),
    headers: { authorization: `Bearer ${options.token}` },
    fetch: (request, init, { context }) => {
      const signals = [
        request.signal,
        AbortSignal.timeout(context.timeoutMs ?? options.timeoutMs ?? 60_000),
      ];
      const extra = options.signal?.();
      if (extra) signals.push(extra);
      return send(request, { ...init, signal: AbortSignal.any(signals) });
    },
    plugins: [new ResponseValidationPlugin(botdContract)],
    interceptors: [
      async ({ next, path }) => {
        const call = procedureAt(path);
        try {
          return await (options.around ? options.around(call, next) : next());
        } catch (error) {
          throw botdError(call.path, error);
        }
      },
    ],
    // `{ error, code }`, or `{ error }` from a botd deployed before the contract.
    customErrorResponseBodyDecoder: (body, response) => {
      if (typeof body !== "object" || body === null || !("error" in body)) return null;
      const { error, code } = body as { error: unknown; code?: unknown };
      if (typeof error !== "string") return null;
      return new ORPCError(typeof code === "string" ? code : "BOTD_ERROR", {
        status: response.status,
        message: error,
      });
    },
  });
  return createORPCClient(link);
}

function botdError(path: string, error: unknown): unknown {
  if (error instanceof BotdError) return error;
  if (error instanceof ORPCError) return new BotdError(path, error.status, error.message);
  // The answer came back but doesn't fit the contract: a botd too old or too new for this caller.
  if (error instanceof ValidationError) {
    const issues = error.issues.map((issue) => {
      const at = (issue.path ?? []).map((part) =>
        typeof part === "object" ? String(part.key) : String(part),
      );
      return `${at.join(".") || "(root)"}: ${issue.message}`;
    });
    return new BotdError(path, 502, `${error.message}: ${issues.join("; ")}`);
  }
  return error;
}
