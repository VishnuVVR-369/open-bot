import { toast } from "sonner";

/** Reloads tried for one deploy, kept for the tab's session so they survive the reload itself. */
interface Attempts {
  deployment: string;
  count: number;
  at: number;
}

const ATTEMPTS_KEY = "openbot:deployment-reloads";
/**
 * How long to wait before each reload for one deploy. While the old and new servers both run, a
 * reload can land on the old one again; later tries give the switch time to finish.
 */
const BACKOFF_MS = [0, 5_000, 30_000];

/** What a tab does once it learns the server runs another deploy than its own code. */
export type ReloadPlan =
  { kind: "now" } | { kind: "later"; inMs: number } | { kind: "when-hidden" } | { kind: "ask" };

export function planReload(options: {
  /** The tab is in the background. */
  hidden: boolean;
  /** Focus is in a text field, so a reload now could throw away what you're typing. */
  editing: boolean;
  /** Reloads this tab already tried for the same deploy. */
  attempts: Attempts | null;
  now: number;
}): ReloadPlan {
  const count = options.attempts?.count ?? 0;
  // Reloading keeps bringing back older code, say a cache serving an old page: stop and say so.
  if (count >= BACKOFF_MS.length) return { kind: "ask" };
  if (options.editing && !options.hidden) return { kind: "when-hidden" };
  const due = options.attempts ? options.attempts.at + BACKOFF_MS[count]! : options.now;
  return due > options.now ? { kind: "later", inMs: due - options.now } : { kind: "now" };
}

/** The browser pieces a reloader uses, so tests can stand in for them. */
export interface ReloaderEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  /** Focus is in a text field. */
  editing: () => boolean;
  reload: () => void;
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  /** Says a newer version is ready, with a way to load it; null takes that back. */
  notify: (notice: { onReload: () => void; reloadsWhenHidden: boolean } | null) => void;
}

function isEditing(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.isContentEditable ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
        element.type,
      ))
  );
}

/**
 * Loads a new deploy's code. The server's API and actions change with a deploy, and a tab still
 * running the old code would call ones that no longer exist. Drafts survive, since the composer
 * keeps them in local storage; a half-typed field elsewhere waits until you leave the tab.
 */
export function createReloader(environment: ReloaderEnvironment) {
  let pending: (() => void) | null = null;

  const readAttempts = (deployment: string): Attempts | null => {
    try {
      const saved = JSON.parse(environment.storage?.getItem(ATTEMPTS_KEY) ?? "null") as Attempts;
      return saved?.deployment === deployment ? saved : null;
    } catch {
      return null;
    }
  };

  const cancel = () => {
    pending?.();
    pending = null;
  };

  /** Counts one more reload for `deployment`; false when the count can't be kept across it. */
  const record = (deployment: string): boolean => {
    const count = (readAttempts(deployment)?.count ?? 0) + 1;
    try {
      if (!environment.storage) return false;
      environment.storage.setItem(
        ATTEMPTS_KEY,
        JSON.stringify({ deployment, count, at: environment.now() } satisfies Attempts),
      );
    } catch {
      return false;
    }
    return readAttempts(deployment)?.count === count;
  };

  /** You asked for it: reload whether or not the count could be kept. */
  const reload = (deployment: string) => {
    cancel();
    record(deployment);
    environment.reload();
  };

  /**
   * Reloads by itself only with the count kept, since that count is what stops a loop when
   * reloads keep bringing back old code. Without it, you get the notice and decide.
   */
  const reloadByItself = (deployment: string) => {
    cancel();
    if (record(deployment)) return environment.reload();
    environment.notify({ onReload: () => reload(deployment), reloadsWhenHidden: false });
  };

  const outdated = (deployment: string) => {
    cancel();
    const plan = planReload({
      hidden: environment.document.hidden,
      editing: environment.editing(),
      attempts: readAttempts(deployment),
      now: environment.now(),
    });
    if (plan.kind === "now") return reloadByItself(deployment);
    if (plan.kind === "later") {
      const timer = environment.setTimeout(() => outdated(deployment), plan.inMs);
      pending = () => environment.clearTimeout(timer);
      return;
    }
    environment.notify({
      onReload: () => reload(deployment),
      reloadsWhenHidden: plan.kind === "when-hidden",
    });
    if (plan.kind === "ask") return;
    const onVisibility = () => {
      if (environment.document.hidden) outdated(deployment);
    };
    environment.document.addEventListener("visibilitychange", onVisibility);
    pending = () => environment.document.removeEventListener("visibilitychange", onVisibility);
  };

  return {
    /** The server runs `deployment`, which isn't this tab's: get its code. */
    outdated,
    /** The server runs this tab's own deploy: nothing to do, and earlier tries are done with. */
    current() {
      cancel();
      environment.notify(null);
      try {
        environment.storage?.removeItem(ATTEMPTS_KEY);
      } catch {
        // Nothing saved.
      }
    },
  };
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let browserReloader: ReturnType<typeof createReloader> | null = null;

/** The reloader for this tab. */
export function deploymentReloader() {
  browserReloader ??= createReloader({
    storage: sessionStorageOrNull(),
    document,
    editing: () => isEditing(document.activeElement),
    reload: () => window.location.reload(),
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (timer) => window.clearTimeout(timer as number),
    notify: (notice) => {
      if (!notice) return void toast.dismiss("deployment");
      toast("open-bot was updated", {
        id: "deployment",
        description: notice.reloadsWhenHidden
          ? "Reload to keep using it. It reloads by itself when you switch away."
          : "Reload to keep using it.",
        duration: Infinity,
        action: { label: "Reload", onClick: notice.onReload },
      });
    },
  });
  return browserReloader;
}
