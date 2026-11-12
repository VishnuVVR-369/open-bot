/** What every integration's calls to its provider share: how a failure is told, and tokens. */

/** A provider call failed. `ambiguous` means it may have happened anyway. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The request may have reached the provider and taken effect (a timeout, a reset, a 5xx). */
    readonly ambiguous: boolean,
    /** The provider's own reason, like `accessNotConfigured` or `insufficientPermissions`. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/** The account's current access token, and a way to get a new one after a 401. */
export interface TokenSource {
  token(): Promise<string>;
  refresh(): Promise<string>;
}
