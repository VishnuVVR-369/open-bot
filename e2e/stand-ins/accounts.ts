import http from "node:http";
import { type Exchange, type Fault, json, type RecordedRequest } from "./http";
import { headerOf, parseMime } from "./mime";
import { GoogleStandIn } from "./google";
import { GmailStandIn } from "./gmail";
import { CalendarStandIn } from "./calendar";
import { NotionStandIn } from "./notion";

/**
 * One server standing in for Google (OAuth, Gmail and Calendar) and for Notion's hosted MCP (its
 * OAuth with dynamic client registration and PKCE, and its tools), so the accounts feature can be
 * tested end to end without real accounts. Start the web app and the worker pointed at it:
 *
 *   GOOGLE_BASE_URL=http://127.0.0.1:4796 NOTION_MCP_URL=http://127.0.0.1:4796/mcp pnpm dev
 *
 * It speaks the providers' formats as the app reads them: Google's error bodies, Gmail's message
 * resources and search syntax, Calendar's etags and ids, Notion's rotating refresh tokens. Tests
 * drive it in process (the methods below are its control API); `GET /_control/state` shows its
 * state while a test runs.
 *
 * Refresh tokens it never issued get a passing failure, not `invalid_grant`, so a run against the
 * wrong database can't mark someone's real account for reconnecting.
 */

export const STAND_IN_PORT = 4796;

export const STAND_IN_URL = `http://127.0.0.1:${STAND_IN_PORT}`;

// ---------------------------------------------------------------------------------------------

/** Google and Notion, on one port. */
export class AccountsStandIn {
  google!: GoogleStandIn;
  gmail!: GmailStandIn;
  calendar!: CalendarStandIn;
  notion!: NotionStandIn;
  /** Every provider request, in order. */
  requests: RecordedRequest[] = [];
  private faults: (Fault & { times: number })[] = [];
  private server: http.Server | null = null;

  constructor(readonly origin = STAND_IN_URL) {
    this.reset();
  }

  /** Back to a fresh mailbox, calendar and workspace, with nobody signed in. */
  reset() {
    void this.notion?.close();
    this.google = new GoogleStandIn();
    const owner = () => this.google.signInAs.email;
    this.gmail = new GmailStandIn(this.google, owner);
    this.calendar = new CalendarStandIn(this.google, owner);
    this.notion = new NotionStandIn(this.origin);
    this.requests = [];
    this.faults = [];
  }

  /** The next `times` requests matching get this instead. */
  fail(fault: Fault) {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  /** Requests to a path, like `/gmail/v1/users/me/messages/send`. */
  requestsTo(path: string | RegExp, method?: string): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        (method === undefined || request.method === method) &&
        (typeof path === "string" ? request.path === path : path.test(request.path)),
    );
  }

  /** What tests and people debugging them want to see. */
  state() {
    return {
      google: {
        clients: [...this.google.clients.keys()],
        grantedScopes: this.google.grantedScopes(),
        authorizations: this.google.authorizations,
        tokenRequests: this.google.tokenRequests,
        revocations: this.google.revocations.length,
      },
      gmail: {
        messages: [...this.gmail.messages.values()].map((message) => ({
          id: message.id,
          threadId: message.threadId,
          labels: [...message.labelIds],
          subject: headerOf(message.mime, "Subject"),
          to: headerOf(message.mime, "To"),
        })),
        drafts: [...this.gmail.drafts.keys()],
        sent: this.gmail.sent.map((message) => ({
          id: message.id,
          to: headerOf(parseMime(message.raw), "To"),
          subject: headerOf(parseMime(message.raw), "Subject"),
        })),
      },
      calendar: {
        events: [...this.calendar.events.values()].flatMap((events) => [...events.values()]),
        writes: this.calendar.writes,
      },
      notion: {
        clients: [...this.notion.clients.keys()],
        pages: [...this.notion.pages.values()],
        calls: this.notion.calls,
        revocations: this.notion.revocations.length,
      },
      requests: this.requests.length,
    };
  }

  async start(port = STAND_IN_PORT) {
    this.server = http.createServer((req, res) => {
      void this.serve(req, res).catch((error: unknown) => {
        if (!res.headersSent)
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { code: 500, message: String(error) } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
  }

  async stop() {
    await this.notion.close();
    const server = this.server;
    this.server = null;
    if (!server) return;
    // The MCP client keeps a stream open, which would hold close() up.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", this.origin);
    const ex: Exchange = {
      req,
      res,
      url,
      method: req.method ?? "GET",
      body: Buffer.concat(chunks),
      drop: false,
    };
    if (url.pathname === "/_control/state") return json(ex, 200, this.state());
    this.requests.push({
      method: ex.method,
      path: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams),
      at: Date.now(),
    });
    const fault = this.faults.find(
      (entry) =>
        entry.times > 0 &&
        (entry.method === undefined || entry.method === ex.method) &&
        entry.path.test(url.pathname),
    );
    if (fault) {
      fault.times -= 1;
      if (fault.drop) ex.drop = true;
      else
        return json(
          ex,
          fault.status ?? 500,
          fault.body ?? {
            error: {
              code: fault.status ?? 500,
              message: "Backend Error",
              errors: [{ reason: "backendError" }],
            },
          },
        );
    }
    if (this.google.handle(ex)) return;
    if (this.gmail.handle(ex)) return;
    if (this.calendar.handle(ex)) return;
    if (await this.notion.handle(ex)) return;
    json(ex, 404, { error: { code: 404, message: `Nothing at ${ex.method} ${url.pathname}` } });
  }
}
