import { publishApp, type Context } from "../../context";
import type { ChatgptAuthSource, CodexStatus } from "../../codex";
import { errorMessage } from "../../logger";
import { saveSettings } from "../settings";

/**
 * The ChatGPT account Codex runs as, from the owner's settings: signed in with a device code, or
 * with the login of the Mac running the stack.
 */
export class CodexAccountService {
  constructor(private readonly ctx: Pick<Context, "db" | "codex" | "pool" | "log">) {}

  /** Save where the login comes from and sign in again with it. */
  async setAuthSource(source: ChatgptAuthSource): Promise<CodexStatus> {
    await saveSettings(this.ctx.db, { chatgptAuthSource: source });
    // A device login starts from nothing, not from the Mac's login it replaces.
    if (source === "device")
      await this.ctx.codex.logout().catch((error: unknown) =>
        this.ctx.log.warn("couldn't sign out of ChatGPT before a device sign-in", {
          error: errorMessage(error),
        }),
      );
    const status = await this.ctx.codex.reauthenticate();
    await publishApp(this.ctx, { type: "auth" });
    return status;
  }

  async logout(): Promise<void> {
    await this.ctx.codex.logout();
    await publishApp(this.ctx, { type: "auth" });
  }
}
