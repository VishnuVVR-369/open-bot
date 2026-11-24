/** The waits before each new try after a registration fails; then the next resume, reconnect or new token tries. */
export const REGISTER_RETRY_MS = [5_000, 30_000, 2 * 60_000] as const;

export interface RegistrarDeps {
  /** This sign-in's registration, which every push to the phone must carry. */
  registration: string;
  /** The phone's FCM token now. */
  token: () => Promise<string>;
  /** Registers the token with the registration, and returns the registration the server stored. */
  register: (token: string, registration: string) => Promise<string | undefined>;
  onError?: (error: unknown) => void;
}

/**
 * Keeps this phone's FCM token on the server with this sign-in's registration. A registration
 * counts as stored only when the server says it stored that very one: a failed request, or a
 * server that dropped it (one older than this app), is tried again with backoff, then on the
 * next `sync()`. The app calls `sync()` when it starts, comes back to the screen, gets back
 * online or gets a new token, and `stop()` when you sign out; nothing is sent after that.
 *
 * Until then, the phone draws only pushes that carry this registration, and a registration is
 * this sign-in's alone: an unconfirmed one can miss pushes, never show another sign-in's.
 */
export class PushRegistrar {
  /** The token the server has with this registration, as far as this phone knows. */
  private stored: string | null = null;
  private running = false;
  /** `sync()` was called during a try: try again once it's done. */
  private again = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: RegistrarDeps) {}

  /** Something may have changed: make sure the server has the latest token, with a fresh set of tries. */
  sync(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.clearTimer();
    this.attempt = 0;
    void this.run();
  }

  /** Signed out: no try starts, and a reply that arrives later changes nothing. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Whether the server stored this registration with the token it had last. */
  get confirmed(): boolean {
    return this.stored !== null;
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      const token = await this.deps.token();
      if (this.stopped || token === this.stored) return;
      this.stored = null;
      const echoed = await this.deps.register(token, this.deps.registration);
      if (this.stopped) return;
      if (echoed !== this.deps.registration)
        throw new Error("The server didn't store this sign-in's registration");
      this.stored = token;
    } catch (error) {
      if (this.stopped) return;
      this.deps.onError?.(error);
      const delay = REGISTER_RETRY_MS[this.attempt];
      if (delay !== undefined && !this.again) {
        this.attempt += 1;
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run();
        }, delay);
      }
    } finally {
      this.running = false;
      if (this.again && !this.stopped) {
        this.again = false;
        this.sync();
      }
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
