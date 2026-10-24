import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The Chrome DevTools Protocol over `--remote-debugging-pipe`: JSON messages separated by NUL bytes,
 * written to the browser's fd 3 and read from its fd 4. Only botd holds the pipe, so no other
 * process on the computer can drive the browser or read its cookies through it.
 */
export class CdpPipe extends EventEmitter<{ close: [] }> {
  private nextId = 0;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly output: Writable,
    input: Readable,
  ) {
    super();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.receive(chunk));
    input.on("close", () => this.close());
    input.on("error", () => this.close());
    output.on("error", () => this.close());
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\0")) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    }
  }

  /** Send a command to the browser, or with `sessionId`, to a page attached in flat mode. */
  send<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser is closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.output.write(
        `${JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })}\0`,
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The browser is closed"));
    }
    this.pending.clear();
    this.emit("close");
  }
}
