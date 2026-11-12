/** The statuses a request the worker refuses can answer with. */
export type RefusalStatus = 400 | 403 | 404 | 409 | 413 | 429 | 503;

/**
 * A request the worker can't do as asked, with a message for whoever asked: the owner, through
 * a procedure, gets `status` and the message; a teammate, through a tool, gets the message as the
 * tool's failed reply. Every service's own error extends this, so both map it in one place
 * (`rpc/errors.ts`, `tools/handlers.ts`). Anything else is a fault, logged and answered as one.
 */
export class WorkerError extends Error {
  constructor(
    readonly status: RefusalStatus,
    message: string,
  ) {
    super(message);
  }
}
