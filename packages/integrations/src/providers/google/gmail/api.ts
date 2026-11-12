import { googleEndpoints } from "../../../core/endpoints";
import type { ProviderError, TokenSource } from "../../../core/http";
import { providerJson } from "../http";
import type { GmailPart } from "./mime";

/** Gmail's REST API: its shapes, the client for one account, and its refusals said plainly. */

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

export interface GmailDraft {
  id: string;
  message: { id: string; threadId: string; raw?: string };
}

/** Gmail's REST API, for one account. */
export class GmailApi {
  private readonly base = `${googleEndpoints().gmail}/users/me`;
  constructor(private readonly tokens: TokenSource) {}

  async get<T>(
    path: string,
    query?: Record<string, string | number | string[] | undefined>,
  ): Promise<T> {
    return (await providerJson<T>(this.tokens, { url: `${this.base}${path}`, query, mode: "read" }))
      .body;
  }

  async write<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    return (
      await providerJson<T>(this.tokens, {
        method,
        url: `${this.base}${path}`,
        body,
        mode: "write",
      })
    ).body;
  }
}

export function header(message: GmailMessage | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return (
    message?.payload?.headers?.find((entry) => entry.name.toLowerCase() === wanted)?.value ?? ""
  );
}

export function cap(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n[… cut at ${max.toLocaleString("en-US")} characters]`
    : text;
}

/** The provider's refusal as the teammate reads it, with the fix where there is one. */
export function gmailProblem(error: ProviderError): string {
  if (error.reason === "accessNotConfigured" || error.reason === "SERVICE_DISABLED")
    return "The Gmail API isn't enabled in the user's Google Cloud project. Ask them to enable it (APIs & Services → Library → Gmail API), then try again.";
  if (error.reason === "insufficientPermissions" || error.status === 403)
    return `Gmail refused it: ${error.message} The user may need to reconnect Gmail in Settings → Connections and allow it.`;
  if (error.status === 404)
    return "Gmail has no such message, thread or draft. Search again for its id.";
  return `Gmail: ${error.message}`;
}
