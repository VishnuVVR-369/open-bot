import { botdContract } from "@open-bot/api/botd";
import {
  domainMatches,
  isOwnerLease,
  USER_HAS_CONTROL_MESSAGE,
  type ComputerAction,
  type ComputerActionError,
  type ComputerActionResult,
  type ComputerFillRequest,
  type ComputerFillResult,
  type ComputerHealth,
  type ComputerReadResult,
  type RunIdentity,
} from "@open-bot/domain";
import { implement, ORPCError } from "@orpc/server";
import { ActionAbortedError, Desktop } from "./desktop";
import type { EgressRouter } from "@open-bot/egress/router";
import type { ComputeLifecycle } from "./lifecycle";
import type { PageChecker } from "./pages";
import type { Screen, ScreenManager } from "./screens";

/**
 * Implements `botdContract`: each procedure calls the screen manager, the lifecycle or the page
 * checker. The HTTP server (`server.ts`) checks the token first, and the handler (`rpc.ts`) counts
 * activity and turns errors into statuses.
 */

export interface RouterDeps {
  lifecycle?: ComputeLifecycle;
  screens: ScreenManager;
  egress: EgressRouter;
  health: () => ComputerHealth;
  pages: PageChecker;
}

const os = implement(botdContract);

function failed(error: unknown): ComputerActionError {
  return {
    ok: false,
    code: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

const userHasControl: ComputerActionError = {
  ok: false,
  code: "user_has_control",
  message: USER_HAS_CONTROL_MESSAGE,
};

export function createRouter(deps: RouterDeps) {
  const { screens } = deps;

  /** The lifecycle, for a call that only makes sense when it is on. */
  function lifecycle(): ComputeLifecycle {
    if (!deps.lifecycle?.enabled)
      throw new ORPCError("CONFLICT", { status: 409, message: "Lifecycle disabled" });
    return deps.lifecycle;
  }

  /** The run's own screen, once it holds it. */
  async function screenForRun(
    run: RunIdentity,
    signal?: AbortSignal,
  ): Promise<Screen | ComputerActionError> {
    // Every teammate works on its own screen, and a swarm helper on one of its own.
    const screenId = run.screenId ?? run.teammateId;
    let screen: Screen;
    try {
      // Before the screen starts, so its first connections can wait for a phone.
      deps.egress.noteDemand(screenId);
      screen = await screens.ensure(screenId, signal);
      signal?.throwIfAborted();
    } catch (error) {
      return {
        ok: false,
        code: "failed",
        message: `Your screen couldn't start: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const acquired = await screen.lease.acquireForRun(run);
    signal?.throwIfAborted();
    if (acquired === "user_has_control") return userHasControl;
    if (acquired === "desktop_busy") {
      return {
        ok: false,
        code: "desktop_busy",
        message:
          "You're using your screen in another chat right now. Do other work and try the desktop again later.",
      };
    }
    screens.touch(screen);
    return screen;
  }

  async function performAction(
    { run, action }: { run: RunIdentity; action: ComputerAction },
    signal?: AbortSignal,
  ): Promise<ComputerActionResult | ComputerActionError> {
    const screen = await screenForRun(run, signal);
    if (!("lease" in screen)) return screen;
    const { lease, desktop } = screen;
    try {
      await desktop.perform(action);
      const settle = Desktop.settleMs(action);
      if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
      // Taking over during the action means the teammate must not see the screen anymore.
      if (isOwnerLease(lease.holder)) throw new ActionAbortedError();
      const [image, cursor] = await Promise.all([desktop.screenshot(), desktop.cursor()]);
      if (isOwnerLease(lease.holder)) throw new ActionAbortedError();
      const blocked = screen.takeBlocked();
      return {
        ok: true,
        screenshot: image.toString("base64"),
        cursor,
        ...(blocked.length && { blocked }),
      };
    } catch (error) {
      if (error instanceof ActionAbortedError || isOwnerLease(lease.holder)) return userHasControl;
      return failed(error);
    }
  }

  /** The readable content of the page in front on the run's screen. */
  async function performRead(
    { run, selector }: { run: RunIdentity; selector?: string },
    signal?: AbortSignal,
  ): Promise<ComputerReadResult | ComputerActionError> {
    const screen = await screenForRun(run, signal);
    if (!("lease" in screen)) return screen;
    try {
      const page = await screen.readPage(selector);
      if (isOwnerLease(screen.lease.holder)) return userHasControl;
      if ("error" in page) return { ok: false, code: "failed", message: page.error };
      const blocked = screen.takeBlocked();
      return { ok: true, ...page, ...(blocked.length && { blocked }) };
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * Type a vault secret into whatever has focus on the run's screen. A login only fills on its own
   * site, so a misleading page can't collect it. Nothing about the secret is logged or returned.
   */
  async function performFill(
    { run, secret, site }: ComputerFillRequest,
    signal?: AbortSignal,
  ): Promise<ComputerFillResult | ComputerActionError> {
    if (!secret || secret.length > 500) {
      return { ok: false, code: "invalid_action", message: "Nothing to fill" };
    }
    const screen = await screenForRun(run, signal);
    if (!("lease" in screen)) return screen;
    let pages: string[];
    try {
      pages = await screen.visiblePages();
    } catch {
      pages = [];
    }
    if (site) {
      const hosts = pages.map((page) => {
        try {
          return new URL(page).hostname;
        } catch {
          return "";
        }
      });
      if (hosts.length === 0 || !hosts.every((host) => domainMatches(host, site))) {
        return {
          ok: false,
          code: "wrong_site",
          message:
            hosts.length === 0
              ? `The browser isn't showing a page. Open the ${site} sign-in page first.`
              : `The browser is showing ${hosts.filter(Boolean).join(", ") || "a page without an address"}, not ${site}, so it wasn't filled. Open the ${site} sign-in page and click the field first.`,
        };
      }
    }
    try {
      signal?.throwIfAborted();
      await screen.desktop.typeSecret(secret);
      if (isOwnerLease(screen.lease.holder)) throw new ActionAbortedError();
      return { ok: true, pages };
    } catch (error) {
      if (error instanceof ActionAbortedError || isOwnerLease(screen.lease.holder))
        return userHasControl;
      return { ok: false, code: "failed", message: "Typing it on the screen failed." };
    }
  }

  return os.router({
    healthz: os.healthz.handler(() => {
      if (!deps.lifecycle?.enabled && !deps.health().ok)
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          status: 503,
          message: "The computer isn't healthy",
        });
      return { ok: true as const };
    }),
    health: os.health.handler(() => deps.health()),
    lifecycle: {
      capabilities: os.lifecycle.capabilities.handler(
        () => deps.lifecycle?.status ?? { version: 1, enabled: false },
      ),
      lease: os.lifecycle.lease.handler(({ input }) => {
        const current = lifecycle();
        current.lease(input.owner, input.demand);
        return current.status;
      }),
      ensure: os.lifecycle.ensure.handler(async ({ input }) => {
        const current = lifecycle();
        await current.ensure(input.owner);
        return current.status;
      }),
      quiesce: os.lifecycle.quiesce.handler(async ({ input }) => {
        const current = lifecycle();
        await current.quiesce(input.owner);
        return current.status;
      }),
    },
    computer: {
      action: os.computer.action.handler(({ input, signal }) => performAction(input, signal)),
      read: os.computer.read.handler(({ input, signal }) => performRead(input, signal)),
      fill: os.computer.fill.handler(({ input, signal }) => performFill(input, signal)),
      codeContext: os.computer.codeContext.handler(async ({ input }) => {
        const screen = screens.get(input.screenId);
        return { site: screen ? await screen.codeSite() : null };
      }),
      type: os.computer.type.handler(({ input: { screenId, ...code } }) =>
        screens.typeCode(screenId, code),
      ),
    },
    screens: {
      start: os.screens.start.handler(async ({ input, signal }) => {
        deps.egress.noteDemand(input.screenId);
        return (await screens.ensure(input.screenId, signal)).status();
      }),
      forget: os.screens.forget.handler(async ({ input }) => {
        await screens.forget(input.screenId);
        return { ok: true as const };
      }),
    },
    pages: {
      check: os.pages.check.handler(({ input }) => deps.pages.check(input.path)),
    },
    leases: {
      releaseRun: os.leases.releaseRun.handler(({ input }) => ({
        released: screens.releaseRun(input.runId),
      })),
      take: os.leases.take.handler(async ({ input, signal }) => {
        deps.egress.noteDemand(input.screenId);
        const screen = await screens.ensure(input.screenId, signal);
        if (!screens.codeAvailable(screen.id))
          throw new ORPCError("CONFLICT", { status: 409, message: "Code entry is in progress." });
        return { previous: screen.lease.takeByUser(), holder: screen.lease.holder };
      }),
      release: os.leases.release.handler(async ({ input }) => {
        const screen = screens.get(input.screenId);
        return {
          released: screen
            ? await screen.lease.releaseSafely(
                input.reason ?? "handed_back",
                input.clearCode === true,
              )
            : !screens.list().some((s) => s.id === input.screenId && isOwnerLease(s.lease)),
        };
      }),
      touch: os.leases.touch.handler(({ input }) => {
        const screen = screens.get(input.screenId);
        screen?.lease.touchUser();
        return { holder: screen?.lease.holder ?? null };
      }),
    },
  });
}

export type BotdRouter = ReturnType<typeof createRouter>;
