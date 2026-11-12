import type { AccountProvider } from "@open-bot/domain";

/**
 * Where the providers live. Each app reads the overrides from its own env module and passes them
 * in; tests and e2e runs point them at a stand-in, and nothing else changes.
 */

export interface GoogleEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  userinfo: string;
  gmail: string;
  calendar: string;
}

export interface IntegrationEndpoints {
  google: GoogleEndpoints;
  /** Notion's hosted MCP server, which also leads to its sign-in. */
  notionMcpUrl: string;
}

export interface EndpointOverrides {
  /** One base for Google's sign-in, Gmail and Calendar (`GOOGLE_BASE_URL`). */
  googleBaseUrl?: string;
  /** Notion's MCP server (`NOTION_MCP_URL`). */
  notionMcpUrl?: string;
}

function googleEndpoints(base: string | undefined): GoogleEndpoints {
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

/** The providers' real endpoints, or the stand-ins the overrides name. */
export function integrationEndpoints(overrides: EndpointOverrides = {}): IntegrationEndpoints {
  return {
    google: googleEndpoints(overrides.googleBaseUrl || undefined),
    notionMcpUrl: overrides.notionMcpUrl || "https://mcp.notion.com/mcp",
  };
}

/** Where a provider sends you back after you sign in: the web app's callback route. */
export function redirectUri(appUrl: string, provider: AccountProvider): string {
  return `${appUrl.replace(/\/+$/, "")}/api/accounts/${provider}/callback`;
}
