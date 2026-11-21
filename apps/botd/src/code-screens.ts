import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { isOwnerLease, isScreenId, type CodeEntryResult } from "@open-bot/domain";
import type { ReleaseGuard } from "./lease";
import type { Screen } from "./screens";

/** How many code entries botd remembers the answer of, for a worker that lost one. */
const REMEMBERED_OUTCOMES = 1_000;

/** Only screen ids are durable. A crash always restores owner-only quarantine. */
export class CodeScreens {
  private readonly protected = new Set<string>();
  private readonly secrets = new Map<string, string>();
  private readonly busy = new Set<string>();
  /** Every code entry botd got or refused to run, by operation id, with its answer. Never the code. */
  private readonly outcomes = new Map<string, Promise<CodeEntryResult>>();
  constructor(private readonly directory: string) {}
  get ids(): readonly string[] {
    return [...this.protected];
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.directory)) if (isScreenId(id)) this.protected.add(id);
  }

  private async syncDirectory(): Promise<void> {
    const dir = await open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  attach(screen: Screen): void {
    if (this.protected.has(screen.id))
      screen.lease.protectCode((clear, reason) => this.release(screen, clear, reason), true);
  }

  available(id: string): boolean {
    return !this.busy.has(id);
  }

  private async release(
    screen: Screen,
    clear: boolean,
    reason: Parameters<ReleaseGuard>[1],
  ): Promise<boolean> {
    if (this.busy.has(screen.id)) return false;
    this.busy.add(screen.id);
    try {
      const secret = this.secrets.get(screen.id);
      // A restart forgot the code, so nothing can prove it is gone. Only your explicit
      // "Clear the code and hand back" discards the browser pages; a timeout keeps it paused.
      const safe = secret
        ? await screen.checkCode(secret, clear)
        : clear && reason === "handed_back" && (await screen.clearRecoveredCode());
      if (!safe) return false;
      await unlink(`${this.directory}/${screen.id}`);
      await this.syncDirectory();
      this.protected.delete(screen.id);
      this.secrets.delete(screen.id);
      return true;
    } catch {
      return false;
    } finally {
      this.busy.delete(screen.id);
    }
  }

  /** Forget a screen whose browser profile was deleted: no page of it can show a code anymore. */
  async forget(id: string): Promise<void> {
    if (!this.protected.has(id)) return;
    await unlink(`${this.directory}/${id}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.syncDirectory();
    this.protected.delete(id);
    this.secrets.delete(id);
  }

  private remember(operationId: string, outcome: Promise<CodeEntryResult>): void {
    this.outcomes.set(operationId, outcome);
    // Maps iterate in insertion order, so this drops the oldest.
    for (const id of this.outcomes.keys()) {
      if (this.outcomes.size <= REMEMBERED_OUTCOMES) break;
      this.outcomes.delete(id);
    }
  }

  /**
   * What became of a code entry whose answer the worker lost. One botd got answers as `type` did,
   * once it finishes. One botd never got is refused from now on, so a request still on its way
   * can't type later: nothing was typed for it, unless the screen is protected, where a restart
   * may have forgotten that this entry typed there before it.
   */
  outcome(screenId: string, operationId: string): Promise<CodeEntryResult> {
    const known = this.outcomes.get(operationId);
    if (known) return known;
    const answer: CodeEntryResult = this.protected.has(screenId)
      ? { status: "unknown", reason: "Check the screen before sending again." }
      : {
          status: "failed",
          reason: "The computer never got the code, so nothing was typed. Send it again.",
        };
    this.remember(operationId, Promise.resolve(answer));
    return Promise.resolve(answer);
  }

  /** Type a one-time code, once per operation id: a repeated id never types again. */
  type(
    screen: Screen,
    input: { operationId: string; expectedSite: string; text: string; pressEnter: boolean },
  ): Promise<CodeEntryResult> {
    if (this.outcomes.has(input.operationId))
      return Promise.resolve({
        status: "unknown",
        reason: "Check the screen before sending again.",
      });
    const outcome = this.enter(screen, input);
    this.remember(input.operationId, outcome);
    return outcome;
  }

  private async enter(
    screen: Screen,
    input: { operationId: string; expectedSite: string; text: string; pressEnter: boolean },
  ): Promise<CodeEntryResult> {
    if (
      this.busy.has(screen.id) ||
      this.protected.has(screen.id) ||
      isOwnerLease(screen.lease.holder)
    )
      return { status: "failed", reason: "The screen is already in use by you." };
    this.busy.add(screen.id);
    let protectedInput = false;
    let previous: CodeEntryResult["previous"] = null;
    try {
      previous = screen.lease.takeByUser();
      const site = await screen.codeSite();
      if (!site || site !== input.expectedSite.toLowerCase()) {
        screen.lease.releaseByUser();
        return {
          status: "failed",
          reason: "The site or focused field changed. Open the code sheet again.",
        };
      }
      const marker = await open(`${this.directory}/${screen.id}`, "wx", 0o600);
      this.protected.add(screen.id);
      this.secrets.set(screen.id, input.text);
      screen.lease.protectCode((clear, reason) => this.release(screen, clear, reason));
      protectedInput = true;
      try {
        await marker.sync();
      } finally {
        await marker.close();
      }
      await this.syncDirectory();
      // Recheck after durable protection, immediately before input.
      if ((await screen.codeSite()) !== site)
        return {
          status: "needs_owner",
          reason: "The focused page changed. Check the screen.",
          previous,
        };
      await screen.desktop.typeSecret(input.text);
      if (input.pressEnter) await screen.desktop.perform({ action: "key", keys: "Return" });
      if (input.pressEnter) {
        const deadline = Date.now() + 10_000;
        do {
          if (await screen.checkCode(input.text, false))
            return { status: "safe", reason: null, previous };
          await new Promise((resolve) => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
      }
      return {
        status: "needs_owner",
        reason: "The code may still be on the page. Check the screen, then hand back.",
        previous,
      };
    } catch {
      if (!protectedInput && !this.protected.has(screen.id)) screen.lease.releaseByUser();
      return {
        status: protectedInput ? "unknown" : "failed",
        reason: "Check the screen before sending again.",
        previous,
      };
    } finally {
      this.busy.delete(screen.id);
    }
  }
}
