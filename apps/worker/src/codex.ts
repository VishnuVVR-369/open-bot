import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { BOTD_SOCKETS } from "@open-bot/api/botd";
import type { CodexStatus } from "@open-bot/api/worker";
import { CodexClient, type ServerNotification, type ServerRequest, type v2 } from "@open-bot/agent";
import type { ComputerLifecycle } from "./computer-lifecycle";
import type { ComputerClient } from "./computer";
import { refreshHostLogin } from "./host-login";
import { errorMessage, type Logger } from "./logger";

export type { CodexStatus };
export type ChatgptAuthSource = CodexStatus["authSource"];

export interface ThreadHandler {
  onNotification(notification: ServerNotification): void;
  onServerRequest(request: ServerRequest): Promise<unknown>;
}

interface HostTokens {
  accessToken: string;
  accountId: string;
}

/** Refresh this Mac's login when its token has less than this left. */
const HOST_REFRESH_MARGIN_MS = 24 * 60 * 60_000;
const HOST_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Owns the connection to the computer's `codex app-server`: connects through botd, signs in,
 * reconnects, and routes thread events to the run that owns the thread.
 */
export class CodexManager extends EventEmitter<{ status: [CodexStatus]; disconnected: [] }> {
  lifecycle?: ComputerLifecycle;
  private generation = 0;
  private client: CodexClient | null = null;
  private connecting: Promise<CodexClient> | null = null;
  private readonly handlers = new Map<string, ThreadHandler>();
  private readonly loadedThreads = new Set<string>();
  private state: CodexStatus;
  private stopped = false;
  private idleIntent = false;
  setIdleIntent(value: boolean): void {
    this.idleIntent = value;
    if (!value && !this.stopped && !this.client?.isOpen) this.scheduleReconnect();
  }
  private retryTimer: NodeJS.Timeout | null = null;
  private hostRefresh: Promise<void> | null = null;
  private lastHostRefresh = 0;
  private cachedRateLimits: v2.GetAccountRateLimitsResponse | null = null;
  private releaseLoginDemand: (() => void) | undefined;

  constructor(
    private readonly computer: ComputerClient,
    private readonly hostAuthFile: string,
    private readonly codexBin: string,
    private readonly getAuthSource: () => Promise<ChatgptAuthSource>,
    private readonly log: Logger,
  ) {
    super();
    this.state = { connected: false, authSource: "host", account: null, login: null, error: null };
  }

  get status(): CodexStatus {
    return this.state;
  }

  private update(patch: Partial<CodexStatus>) {
    this.state = { ...this.state, ...patch };
    this.emit("status", this.state);
  }

  start(): void {
    this.stopped = false;
    void this.ready().catch(() => {});
  }

  async resume(signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    this.idleIntent = false;
    const client = await this.connectOnly(signal);
    if (!client.isOpen) throw new Error("Codex disconnected during wake");
  }

  pause(): void {
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.loadedThreads.clear();
    client?.close();
    this.update({ connected: false, stale: true });
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.client?.close();
  }

  /** A connected, signed-in client. Connects first if needed. */
  async ready(): Promise<CodexClient> {
    if (this.lifecycle?.enabled && !this.lifecycle.inScope)
      await this.lifecycle.run("codex:ready", async () => {});
    if (this.client?.isOpen && this.state.account) return this.client;
    if (this.client?.isOpen && !this.state.account) {
      await this.signIn(this.client);
      if (this.state.account) return this.client;
      throw new Error(
        this.state.error ?? "Codex is not signed in to ChatGPT. Sign in on the Settings page.",
      );
    }
    this.connecting ??= this.newConnection();
    const client = await this.connecting;
    if (!this.state.account) {
      throw new Error(
        this.state.error ?? "Codex is not signed in to ChatGPT. Sign in on the Settings page.",
      );
    }
    return client;
  }

  private newConnection(signal?: AbortSignal): Promise<CodexClient> {
    const pending = this.connect(signal).finally(() => {
      if (this.connecting === pending) this.connecting = null;
    });
    return pending;
  }

  private async connect(signal?: AbortSignal): Promise<CodexClient> {
    const generation = this.generation;
    const client = await CodexClient.connect(
      this.computer.wsUrl(BOTD_SOCKETS.codex),
      (request) => this.onServerRequest(request),
      undefined,
      signal,
    ).catch((error: unknown) => {
      if (generation === this.generation) {
        this.update({
          connected: false,
          error: `Can't reach Codex on the computer: ${errorMessage(error)}`,
        });
        this.lifecycle?.connectionLost();
        this.scheduleReconnect();
      }
      throw error;
    });
    if (generation !== this.generation || this.stopped) {
      client.close();
      throw new Error("Stale Codex connection discarded");
    }
    const request = client.request.bind(client) as CodexClient["request"];
    client.request = ((method, params) =>
      this.lifecycle
        ? this.lifecycle.run(`codex:${method}`, () => request(method, params))
        : request(method, params)) as CodexClient["request"];
    this.client = client;
    this.loadedThreads.clear();
    client.on("notification", (notification) => {
      if (this.client === client) this.onNotification(notification);
    });
    client.on("close", () => {
      if (this.client !== client) return;
      this.client = null;
      this.loadedThreads.clear();
      this.update({
        connected: false,
        ...(this.stopped || this.idleIntent ? { stale: true } : { account: null }),
      });
      this.emit("disconnected");
      this.scheduleReconnect();
    });
    this.update({ connected: true, stale: false, error: null });
    this.log.info("connected to Codex");
    await this.signIn(client);
    return client;
  }

  private scheduleReconnect() {
    if (this.stopped || this.idleIntent || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.client?.isOpen) void this.ready().catch(() => {});
    }, 3_000);
  }

  private async readHostFile(): Promise<HostTokens & { expiry: number | null }> {
    let raw: string;
    try {
      raw = await readFile(this.hostAuthFile, "utf8");
    } catch {
      throw new Error(
        `No Codex login found at ${this.hostAuthFile}. Run \`codex login\` on this Mac.`,
      );
    }
    const auth = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } };
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (!accessToken || !accountId) {
      throw new Error(
        "This Mac's Codex login is not a ChatGPT login. Run `codex login` on this Mac.",
      );
    }
    return { accessToken, accountId, expiry: jwtExpiry(accessToken) };
  }

  /** Have this Mac's Codex refresh its own login. One at a time, and not more than every few minutes. */
  private async refreshHost(): Promise<void> {
    if (Date.now() - this.lastHostRefresh < HOST_REFRESH_MIN_INTERVAL_MS) return;
    this.hostRefresh ??= refreshHostLogin(this.hostAuthFile, this.codexBin, this.log)
      .then(() => {
        this.lastHostRefresh = Date.now();
      })
      .finally(() => (this.hostRefresh = null));
    await this.hostRefresh;
  }

  /** This Mac's ChatGPT token, refreshed through the Mac's own Codex when it's close to expiring. */
  private async readHostTokens(force = false): Promise<HostTokens> {
    let tokens = await this.readHostFile();
    const expiresSoon =
      tokens.expiry !== null && tokens.expiry - Date.now() < HOST_REFRESH_MARGIN_MS;
    if (force || expiresSoon) {
      try {
        await this.refreshHost();
        tokens = await this.readHostFile();
      } catch {
        // Keep using the current token while it is still valid.
      }
    }
    if (tokens.expiry !== null && tokens.expiry < Date.now()) {
      throw new Error(
        "This Mac's Codex login has expired and couldn't be refreshed. Run `codex login` on this Mac.",
      );
    }
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  private async signIn(client: CodexClient): Promise<void> {
    const authSource = await this.getAuthSource();
    if (this.client !== client) return;
    this.update({ authSource });
    try {
      if (authSource === "host") {
        const tokens = await this.readHostTokens();
        await client.request("account/login/start", {
          type: "chatgptAuthTokens",
          accessToken: tokens.accessToken,
          chatgptAccountId: tokens.accountId,
        });
      }
      await this.refreshAccount(client);
      if (!this.state.account && authSource === "device") {
        this.update({ error: "Codex is not signed in to ChatGPT. Sign in on the Settings page." });
      }
    } catch (error) {
      if (this.client === client) this.update({ account: null, error: errorMessage(error) });
    }
  }

  private async refreshAccount(client: CodexClient) {
    const { account } = await client.request("account/read", {});
    if (this.client !== client) return;
    if (!account || account.type === "amazonBedrock") {
      this.update({ account: null });
      return;
    }
    this.update({
      account:
        account.type === "chatgpt"
          ? { type: "chatgpt", email: account.email, planType: account.planType }
          : { type: "apiKey", email: null, planType: null },
      error: null,
      login: null,
    });
  }

  /** Re-run sign-in, for example after switching the auth source. */
  async reauthenticate(): Promise<CodexStatus> {
    const client = this.client?.isOpen ? this.client : await this.connectOnly();
    await this.signIn(client);
    return this.state;
  }

  private async connectOnly(signal?: AbortSignal): Promise<CodexClient> {
    if (this.lifecycle?.enabled && !this.lifecycle.inScope)
      await this.lifecycle.run("codex:connect", async () => {});
    if (this.client?.isOpen) return this.client;
    this.connecting ??= this.newConnection(signal);
    return this.connecting;
  }

  /** Start a device-code login. Codex stores the result in the computer, so it survives restarts. */
  async startDeviceLogin(): Promise<{ verificationUrl: string; userCode: string }> {
    const client = this.client?.isOpen ? this.client : await this.connectOnly();
    this.releaseLoginDemand?.();
    this.releaseLoginDemand = await this.lifecycle?.hold("device-login");
    let response;
    try {
      response = await client.request("account/login/start", { type: "chatgptDeviceCode" });
    } catch (error) {
      this.releaseLoginDemand?.();
      this.releaseLoginDemand = undefined;
      throw error;
    }
    if (response.type !== "chatgptDeviceCode") throw new Error("Unexpected login response");
    const login = { verificationUrl: response.verificationUrl, userCode: response.userCode };
    this.update({ login, error: null });
    return login;
  }

  async logout(): Promise<void> {
    const client = this.client?.isOpen ? this.client : await this.connectOnly();
    await client.request("account/logout", {});
    this.releaseLoginDemand?.();
    this.releaseLoginDemand = undefined;
    this.cachedRateLimits = null;
    this.update({ account: null, login: null, stale: false });
  }

  async rateLimits(refresh = false): Promise<v2.GetAccountRateLimitsResponse | null> {
    // Settings/foreground polling must neither wake the computer nor extend its grace period.
    if (this.lifecycle?.enabled && !refresh) return this.cachedRateLimits;
    const client = this.client;
    if (!client?.isOpen || !this.state.account) return this.cachedRateLimits;
    this.cachedRateLimits = await client.request("account/rateLimits/read", {});
    return this.cachedRateLimits;
  }

  /** Route a thread's events to a run. Returns a function that removes the route. */
  registerThread(threadId: string, handler: ThreadHandler): () => void {
    this.handlers.set(threadId, handler);
    return () => {
      if (this.handlers.get(threadId) === handler) this.handlers.delete(threadId);
    };
  }

  isLoaded(threadId: string): boolean {
    return this.loadedThreads.has(threadId);
  }

  markLoaded(threadId: string): void {
    this.loadedThreads.add(threadId);
  }

  private onNotification(notification: ServerNotification) {
    switch (notification.method) {
      case "account/updated":
      case "account/login/completed":
        if (notification.method === "account/login/completed") {
          this.releaseLoginDemand?.();
          this.releaseLoginDemand = undefined;
        }
        if (this.client) void this.refreshAccount(this.client).catch(() => {});
        if (notification.method === "account/login/completed" && !notification.params.success) {
          this.update({ login: null, error: notification.params.error ?? "Sign-in failed" });
        }
        return;
      default: {
        const params = notification.params as { threadId?: string } | undefined;
        const threadId = params?.threadId;
        if (threadId) this.handlers.get(threadId)?.onNotification(notification);
      }
    }
  }

  private async onServerRequest(request: ServerRequest): Promise<unknown> {
    if (request.method === "account/chatgptAuthTokens/refresh") {
      // The computer's Codex was told its token is no longer good: get a fresh one.
      const tokens = await this.readHostTokens(true);
      return {
        accessToken: tokens.accessToken,
        chatgptAccountId: tokens.accountId,
        chatgptPlanType: null,
      };
    }
    const params = request.params as { threadId?: string };
    const handler = params.threadId ? this.handlers.get(params.threadId) : undefined;
    if (handler) return handler.onServerRequest(request);
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
        return { decision: "decline" };
      case "item/tool/call":
        return {
          success: false,
          contentItems: [
            { type: "inputText", text: "This tool is unavailable outside an open-bot run." },
          ],
        };
      default:
        throw new Error(`Unsupported request ${request.method}`);
    }
  }
}
