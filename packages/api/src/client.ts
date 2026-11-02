import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "./contract";

export type ApiClient = ContractRouterClient<Contract>;

export interface ApiClientOptions {
  /** Where the app is, like `https://openbot.up.railway.app`. */
  appUrl: string;
  /** Headers for every request, such as the session cookie. Called per request. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

/** A typed client for the API at `<appUrl>/api/rpc`. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const custom = options.fetch;
  const link = new RPCLink({
    url: `${options.appUrl.replace(/\/+$/, "")}/api/rpc`,
    headers: async () => (options.headers ? await options.headers() : {}),
    ...(custom ? { fetch: (request: Request, init: RequestInit) => custom(request, init) } : {}),
  });
  return createORPCClient(link);
}
