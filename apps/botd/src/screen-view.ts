// What a screen's browser shows, over its DevTools pipe: its windows filling the screen, the tab
// in front in each, and that tab's content. `Screen` (screens.ts) calls these with its pipe.
import type { PageContent } from "@open-bot/domain";
import type { CdpPipe } from "./cdp";
import { readPageScript } from "./read-page-script";

/** The most of a page `readPage` returns, so one page can't flood a teammate's context. */
const MAX_PAGE_TEXT = 120_000;
const MAX_PAGE_LINKS = 300;

/**
 * Fill the screen. A browser that opens again restores its windows' last bounds instead of
 * honoring --start-maximized, which leaves the desktop showing around it.
 */
export async function maximizeWindows(pipe: CdpPipe) {
  const { targetInfos } = await pipe.send<{ targetInfos: { targetId: string; type: string }[] }>(
    "Target.getTargets",
    {},
  );
  const windows = new Set<number>();
  for (const { targetId, type } of targetInfos) {
    if (type !== "page") continue;
    const { windowId } = await pipe.send<{ windowId: number }>("Browser.getWindowForTarget", {
      targetId,
    });
    windows.add(windowId);
  }
  for (const windowId of windows) {
    await pipe.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "maximized" },
    });
  }
}

/** The addresses of the tabs showing in the browser: the one in front in each window. */
export async function visiblePages(cdp: CdpPipe): Promise<string[]> {
  const { targetInfos } = await cdp.send<{
    targetInfos: { targetId: string; type: string; url: string }[];
  }>("Target.getTargets");
  const visible: string[] = [];
  for (const page of targetInfos.filter((target) => target.type === "page")) {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    try {
      const { result } = await cdp.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        3_000,
        sessionId,
      );
      if (result.value === "visible") visible.push(page.url);
    } catch {
      // A page that doesn't answer isn't one you can fill anything in.
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }
  return visible;
}

/**
 * The readable content of the tab in front: its address, title, visible text and links. With a
 * selector, only that part of the page.
 */
export async function readPage(
  cdp: CdpPipe,
  selector?: string,
): Promise<PageContent | { error: string }> {
  const { targetInfos } = await cdp.send<{
    targetInfos: { targetId: string; type: string; url: string }[];
  }>("Target.getTargets");
  for (const page of targetInfos.filter((target) => target.type === "page")) {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    try {
      const { result } = await cdp.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: readPageScript(selector), returnByValue: true },
        10_000,
        sessionId,
      );
      const value = result.value as
        (PageContent & { visible: boolean; missing?: boolean }) | undefined;
      if (!value?.visible) continue;
      if (value.missing)
        return {
          error: `Nothing on the page matches ${selector}, or it isn't a valid CSS selector.`,
        };
      const truncated = value.text.length > MAX_PAGE_TEXT;
      return {
        url: value.url,
        title: value.title,
        text: truncated ? value.text.slice(0, MAX_PAGE_TEXT) : value.text,
        truncated,
        links: value.links.slice(0, MAX_PAGE_LINKS),
      };
    } catch {
      // A page that doesn't answer isn't the one in front.
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }
  return { error: "No page is showing in the browser." };
}
