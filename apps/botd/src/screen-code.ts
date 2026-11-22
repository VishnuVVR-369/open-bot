// The checks "Type the code" makes on a screen's browser, over its DevTools pipe: which site has
// a focused field, whether the typed code is gone from every tab and frame, and blanking every
// page when botd lost the code. `Screen` (screens.ts) calls these with its pipe.
import type { CdpEvent, CdpPipe } from "./cdp";
import { codeProbe } from "./code-probe";

/** Only a focused editable field on a visible browser tab is eligible for code entry. */
export async function codeSite(cdp: CdpPipe | null): Promise<string | null> {
  if (!cdp?.isOpen) return null;
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>(
    "Target.getTargets",
  );
  const hosts: string[] = [];
  for (const target of targetInfos.filter((t) => t.type === "page")) {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    try {
      const { result } = await cdp.send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        {
          expression: `(() => { let el = document.activeElement; while(el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return document.hasFocus() && document.visibilityState === 'visible' && el?.matches('input:not([disabled]):not([readonly]),textarea:not([disabled]):not([readonly]),[contenteditable="true"]') ? location.hostname : null; })()`,
          returnByValue: true,
        },
        3000,
        sessionId,
      );
      if (result.value) hosts.push(result.value.toLowerCase());
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }
  return hosts.length === 1 ? hosts[0]! : null;
}

/**
 * Check every tab and frame. Any inaccessible document keeps control with the owner. After
 * clearing, `checkAgain` checks without clearing, on the screen's browser as it is by then.
 */
export async function checkCode(
  cdp: CdpPipe | null,
  text: string,
  clear: boolean,
  checkAgain: () => Promise<boolean>,
): Promise<boolean> {
  if (!cdp?.isOpen) return false;
  type Target = { targetId: string; type: string; url: string };
  type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
  try {
    const targets = async () =>
      (await cdp.send<{ targetInfos: Target[] }>("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "page" || t.type === "iframe",
      );
    const before = await targets();
    if (!before.length) return false;
    let safe = true;
    for (const target of before) {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      try {
        type DomNode = {
          shadowRootType?: string;
          children?: DomNode[];
          shadowRoots?: DomNode[];
          contentDocument?: DomNode;
        };
        const { root } = await cdp.send<{ root: DomNode }>(
          "DOM.getDocument",
          { depth: -1, pierce: true },
          3000,
          sessionId,
        );
        const nodes = [root];
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index]!;
          if (node.shadowRootType === "closed") safe = false;
          nodes.push(
            ...(node.children ?? []),
            ...(node.shadowRoots ?? []),
            ...(node.contentDocument ? [node.contentDocument] : []),
          );
        }
        const { frameTree } = await cdp.send<{ frameTree: FrameTree }>(
          "Page.getFrameTree",
          {},
          3000,
          sessionId,
        );
        const frames: FrameTree[] = [frameTree];
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i]!;
          frames.push(...(frame.childFrames ?? []));
          const { executionContextId } = await cdp.send<{ executionContextId: number }>(
            "Page.createIsolatedWorld",
            { frameId: frame.frame.id, worldName: "openbot-code-safety" },
            3000,
            sessionId,
          );
          const { result, exceptionDetails } = await cdp.send<{
            result: { value?: boolean };
            exceptionDetails?: unknown;
          }>(
            "Runtime.evaluate",
            {
              expression: codeProbe(text, clear),
              contextId: executionContextId,
              returnByValue: true,
            },
            3000,
            sessionId,
          );
          if (exceptionDetails || result.value !== true) safe = false;
        }
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    if (clear) return checkAgain();
    const after = await targets();
    const signature = (items: Target[]) =>
      items
        .map((t) => `${t.targetId}:${t.url}`)
        .sort()
        .join("\n");
    return safe && signature(before) === signature(after);
  } catch {
    return false;
  }
}

/** How long one page may take to commit its navigation to about:blank. */
export const BLANK_COMMIT_MS = 5_000;

/**
 * Recovery after botd lost its in-memory code: discard browser pages before releasing. True only
 * when every page is provably blank: each committed the navigation botd started, its frame tree is
 * a lone about:blank frame, and no page opened that wasn't blanked.
 */
export async function clearRecoveredCode(
  cdp: CdpPipe | null,
  commitMs = BLANK_COMMIT_MS,
): Promise<boolean> {
  if (!cdp?.isOpen) return false;
  try {
    const pages = async () =>
      (
        await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets")
      ).targetInfos.filter((t) => t.type === "page");
    const targets = await pages();
    if (!targets.length) return false;
    for (const target of targets)
      if (!(await blankPage(cdp, target.targetId, commitMs))) return false;
    // `Target.getTargets` reports a page's URL only some time after its navigation commits, so the
    // pages themselves were checked above; this only makes sure no page appeared in the meantime.
    const blanked = new Set(targets.map((t) => t.targetId));
    return (await pages()).every((t) => blanked.has(t.targetId));
  } catch {
    return false;
  }
}

type FrameTree = { frame: { id: string; url: string; loaderId: string }; childFrames?: unknown[] };

/** Navigates one page to about:blank and waits for that navigation to commit. */
async function blankPage(cdp: CdpPipe, targetId: string, commitMs: number): Promise<boolean> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  // Main-frame commits on this page, recorded before navigating so none is missed.
  const committed = new Set<string>();
  let onCommit = () => {};
  const listener = (event: CdpEvent) => {
    if (event.sessionId !== sessionId || event.method !== "Page.frameNavigated") return;
    const { frame } = event.params as { frame: { parentId?: string; loaderId: string } };
    if (frame.parentId) return;
    committed.add(frame.loaderId);
    onCommit();
  };
  let onClose = () => {};
  const closed = () => onClose();
  cdp.on("event", listener);
  cdp.on("close", closed);
  let timer: NodeJS.Timeout | undefined;
  try {
    await cdp.send("Page.enable", {}, 3000, sessionId);
    const navigation = await cdp.send<{ loaderId?: string; errorText?: string }>(
      "Page.navigate",
      { url: "about:blank" },
      3000,
      sessionId,
    );
    if (navigation.errorText) return false;
    // Without a loaderId the page was already on about:blank and nothing new commits.
    const loaderId = navigation.loaderId;
    if (loaderId && !committed.has(loaderId)) {
      const arrived = await new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), commitMs);
        onCommit = () => {
          if (committed.has(loaderId)) resolve(true);
        };
        onClose = () => resolve(false);
      });
      if (!arrived) return false;
    }
    const { frameTree } = await cdp.send<{ frameTree: FrameTree }>(
      "Page.getFrameTree",
      {},
      3000,
      sessionId,
    );
    return (
      frameTree.frame.url === "about:blank" &&
      !frameTree.childFrames?.length &&
      (!loaderId || frameTree.frame.loaderId === loaderId)
    );
  } finally {
    clearTimeout(timer);
    cdp.off("event", listener);
    cdp.off("close", closed);
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}
