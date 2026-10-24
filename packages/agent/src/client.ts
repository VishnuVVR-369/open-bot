import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { ServerNotification, ServerRequest } from "./protocol";
import type {
  ListMcpServerStatusParams,
  ListMcpServerStatusResponse,
  FsCreateDirectoryParams,
  FsGetMetadataParams,
  FsGetMetadataResponse,
  FsReadDirectoryParams,
  FsReadDirectoryResponse,
  FsReadFileParams,
  FsReadFileResponse,
  FsRemoveParams,
  FsWriteFileParams,
  GetAccountParams,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  LoginAccountParams,
  LoginAccountResponse,
  SkillsListParams,
  SkillsListResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./protocol/v2";

/** The app-server methods open-bot uses, with their params and results. */
export interface Methods {
  "account/read": [GetAccountParams, GetAccountResponse];
  "account/login/start": [LoginAccountParams, LoginAccountResponse];
  "account/logout": [Record<string, never>, unknown];
  "account/rateLimits/read": [Record<string, never>, GetAccountRateLimitsResponse];
  "thread/start": [ThreadStartParams, ThreadStartResponse];
  "thread/resume": [ThreadResumeParams, ThreadResumeResponse];
  "thread/fork": [ThreadForkParams, ThreadForkResponse];
  "turn/start": [TurnStartParams, TurnStartResponse];
  "turn/steer": [TurnSteerParams, TurnSteerResponse];
  "turn/interrupt": [TurnInterruptParams, unknown];
  "fs/readFile": [FsReadFileParams, FsReadFileResponse];
  "fs/writeFile": [FsWriteFileParams, unknown];
  "fs/readDirectory": [FsReadDirectoryParams, FsReadDirectoryResponse];
  "fs/createDirectory": [FsCreateDirectoryParams, unknown];
  "fs/getMetadata": [FsGetMetadataParams, FsGetMetadataResponse];
  "fs/remove": [FsRemoveParams, unknown];
  "skills/list": [SkillsListParams, SkillsListResponse];
  "mcpServerStatus/list": [ListMcpServerStatusParams, ListMcpServerStatusResponse];
}

export type MethodName = keyof Methods;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * A JSON-RPC client for `codex app-server` over a websocket.
 * Emits `notification` for server notifications and `close` when the connection ends.
 */
export class CodexClient extends EventEmitter<{
  notification: [ServerNotification];
  close: [Error | null];
}> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly handleServerRequest: ServerRequestHandler,
  ) {
    super();
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", (code, reason) =>
      this.onClose(new Error(`Codex connection closed (${code} ${reason.toString()})`)),
    );
    socket.on("error", (error) => this.onClose(error));
  }

  static async connect(
    url: string,
    handleServerRequest: ServerRequestHandler,
    clientInfo = { name: "open-bot", title: "open-bot", version: "0.1.0" },
  ): Promise<CodexClient> {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const client = new CodexClient(socket, handleServerRequest);
    await client.rawRequest("initialize", {
      clientInfo,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.send({ method: "initialized" });
    return client;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  request<M extends MethodName>(method: M, params: Methods[M][0]): Promise<Methods[M][1]> {
    return this.rawRequest(method, params) as Promise<Methods[M][1]>;
  }

  private rawRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: unknown) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onMessage(text: string) {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method === undefined && message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const id = message.id;
      this.handleServerRequest(message as unknown as ServerRequest).then(
        (result) => this.send({ id, result }),
        (error: unknown) =>
          this.send({
            id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
      return;
    }
    if (message.method !== undefined) {
      this.emit("notification", message as unknown as ServerNotification);
    }
  }

  private onClose(error: Error | null) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Codex connection closed"));
    }
    this.pending.clear();
    this.emit("close", error);
  }

  close(): void {
    this.socket.close(1000);
    this.onClose(null);
  }
}
