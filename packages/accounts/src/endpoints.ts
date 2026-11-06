import type { AccountProvider } from "@open-bot/shared";

/**
 * Where the providers live. Tests point these at a stand-in with `GOOGLE_BASE_URL` and
 * `NOTION_MCP_URL`; nothing else changes.
 */

export interface GoogleEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  userinfo: string;
  gmail: string;
  calendar: string;
}

export function googleEndpoints(base = process.env.GOOGLE_BASE_URL): GoogleEndpoints {
  if (base) {
    const root = base.replace(/\/+$/, "");
    return {
      authorize: `${root}/o/oauth2/v2/auth`,
      token: `${root}/token`,
      revoke: `${root}/revoke`,
      userinfo: `${root}/userinfo`,
      gmail: `${root}/gmail/v1`,
      calendar: `${root}/calendar/v3`,
    };
  }
  return {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    gmail: "https://gmail.googleapis.com/gmail/v1",
    calendar: "https://www.googleapis.com/calendar/v3",
  };
}

/** Notion's hosted MCP server. */
export function notionMcpUrl(): string {
  return process.env.NOTION_MCP_URL ?? "https://mcp.notion.com/mcp";
}

/** Where a provider sends you back after you sign in: the web app's callback route. */
export function redirectUri(appUrl: string, provider: AccountProvider): string {
  return `${appUrl.replace(/\/+$/, "")}/api/accounts/${provider}/callback`;
}
