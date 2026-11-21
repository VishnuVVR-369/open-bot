import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CdpPipe } from "./cdp";
import { clearRecoveredCode } from "./screen-code";

type Page = {
  targetId: string;
  /** What `Target.getTargets` reports, which lags behind the page's own frame. */
  listedUrl: string;
  url: string;
  loaderId: string;
  childFrames: number;
};

/**
 * A stand-in browser on the other end of a real DevTools pipe, behaving like Chromium did on the
 * computer: `Page.navigate` answers with the new loaderId before the navigation commits, the commit
 * arrives later as `Page.frameNavigated`, and `Target.getTargets` reports an empty URL for the page
 * all that time and after.
 */
function standInBrowser(urls: string[]) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const cdp = new CdpPipe(toBrowser, fromBrowser);
  const pages: Page[] = urls.map((url) => ({
    targetId: randomUUID(),
    listedUrl: url,
    url,
    loaderId: randomUUID(),
    childFrames: 0,
  }));
  const sessions = new Map<string, Page>();
  const enabled = new Set<string>();
  const options = {
    /** Navigations commit unless this is false. */
    commits: true,
    /** Answer `Page.navigate` with this error instead of navigating. */
    errorText: null as string | null,
    /** Frames a page keeps after committing, such as one the stand-in can't clear. */
    childFramesAfterCommit: 0,
    /** Runs when a page is navigated, after it answered. */
    onNavigate: (_page: Page) => {},
  };
  const send = (message: object) => fromBrowser.write(`${JSON.stringify(message)}\0`);
  let buffer = "";
  toBrowser.setEncoding("utf8");
  toBrowser.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      buffer = buffer.slice(end + 1);
      const page = message.sessionId ? sessions.get(message.sessionId) : undefined;
      const reply = (result: object) => send({ id: message.id, result });
      switch (message.method) {
        case "Target.getTargets":
          reply({
            targetInfos: pages.map((p) => ({
              targetId: p.targetId,
              type: "page",
              url: p.listedUrl,
            })),
          });
          break;
        case "Target.attachToTarget": {
          const sessionId = randomUUID();
          sessions.set(
            sessionId,
            pages.find((p) => p.targetId === message.params.targetId)!,
          );
          reply({ sessionId });
          break;
        }
        case "Target.detachFromTarget":
          reply({});
          break;
        case "Page.enable":
          enabled.add(message.sessionId!);
          reply({});
          break;
        case "Page.navigate": {
          if (options.errorText) {
            reply({ frameId: page!.targetId, errorText: options.errorText });
            break;
          }
          const loaderId = randomUUID();
          page!.listedUrl = "";
          reply({ frameId: page!.targetId, loaderId });
          options.onNavigate(page!);
          if (!options.commits) break;
          setImmediate(() => {
            page!.url = String(message.params.url);
            page!.loaderId = loaderId;
            page!.childFrames = options.childFramesAfterCommit;
            for (const [sessionId, attached] of sessions)
              if (attached === page && enabled.has(sessionId))
                send({
                  method: "Page.frameNavigated",
                  sessionId,
                  params: { frame: { id: page!.targetId, url: page!.url, loaderId } },
                });
          });
          break;
        }
        case "Page.getFrameTree":
          reply({
            frameTree: {
              frame: { id: page!.targetId, url: page!.url, loaderId: page!.loaderId },
              childFrames: Array.from({ length: page!.childFrames }, (_, i) => ({
                frame: { id: `child-${i}`, url: "https://example.com/" },
              })),
            },
          });
          break;
        default:
          send({ id: message.id, error: { message: `unexpected ${message.method}` } });
      }
    }
  });
  return { cdp, pages, options };
}

describe("clearing a code botd forgot in a restart", () => {
  it("releases once every page committed its blank navigation, though the browser still lists empty URLs", async () => {
    const { cdp, pages } = standInBrowser(["https://example.com/verify", "chrome://newtab/"]);
    expect(await clearRecoveredCode(cdp)).toBe(true);
    expect(pages.map((p) => p.url)).toEqual(["about:blank", "about:blank"]);
    // What the old check read: it never shows about:blank right after navigating.
    expect(pages.map((p) => p.listedUrl)).toEqual(["", ""]);
  });

  it("keeps the screen when a navigation never commits", async () => {
    const { cdp, options } = standInBrowser(["https://example.com/verify"]);
    options.commits = false;
    expect(await clearRecoveredCode(cdp, 50)).toBe(false);
  });

  it("keeps the screen when the browser refuses to navigate", async () => {
    const { cdp, options } = standInBrowser(["https://example.com/verify"]);
    options.errorText = "net::ERR_ABORTED";
    expect(await clearRecoveredCode(cdp)).toBe(false);
  });

  it("keeps the screen when a page still has frames after blanking", async () => {
    const { cdp, options } = standInBrowser(["https://example.com/verify"]);
    options.childFramesAfterCommit = 1;
    expect(await clearRecoveredCode(cdp)).toBe(false);
  });

  it("keeps the screen when a page opens while clearing", async () => {
    const { cdp, pages, options } = standInBrowser(["https://example.com/verify"]);
    options.onNavigate = () => {
      if (pages.length === 1)
        pages.push({
          targetId: randomUUID(),
          listedUrl: "https://example.com/popup",
          url: "https://example.com/popup",
          loaderId: randomUUID(),
          childFrames: 0,
        });
    };
    expect(await clearRecoveredCode(cdp)).toBe(false);
  });

  it("keeps the screen when the browser closes while a page commits", async () => {
    const { cdp, options } = standInBrowser(["https://example.com/verify"]);
    options.commits = false;
    options.onNavigate = () => setImmediate(() => cdp.close());
    expect(await clearRecoveredCode(cdp)).toBe(false);
  });

  it("keeps the screen when the browser has no pages or isn't running", async () => {
    expect(await clearRecoveredCode(standInBrowser([]).cdp)).toBe(false);
    expect(await clearRecoveredCode(null)).toBe(false);
  });
});
