// The checks "Type the code" makes on a screen's browser, over its DevTools pipe: which site has
// a focused field, whether the typed code is gone from every tab and frame, and blanking every
// page when botd lost the code. `Screen` (screens.ts) calls these with its pipe.
import type { CdpPipe } from "./cdp";
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

/** Recovery after botd lost its in-memory code: discard browser pages before releasing. */
export async function clearRecoveredCode(cdp: CdpPipe | null): Promise<boolean> {
  if (!cdp?.isOpen) return false;
  try {
    const pages = async () =>
      (
        await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>(
          "Target.getTargets",
        )
      ).targetInfos.filter((t) => t.type === "page");
    const targets = await pages();
    if (!targets.length) return false;
    for (const target of targets) {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      try {
        await cdp.send("Page.navigate", { url: "about:blank" }, 3000, sessionId);
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    const after = await pages();
    return after.length > 0 && after.every((t) => t.url === "about:blank");
  } catch {
    return false;
  }
}
