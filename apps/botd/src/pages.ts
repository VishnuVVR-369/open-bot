import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chown, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import type { Readable, Writable } from "node:stream";
import { readLibFile } from "@open-bot/page-kit/serve";
import {
  COMPUTER_PATHS,
  injectPageRuntime,
  isPageSourcePath,
  MAX_PAGE_BYTES,
  MAX_PAGE_LABEL,
  MAX_PAGE_TEXT_CHARS,
  PAGE_CHECK_WIDTHS,
  PAGE_RESPONSE_HEADERS,
  PAGE_RUNTIME_PATH,
  pageContentSecurityPolicy,
  type PageCheckError,
  type PageCheckResult,
  type PageIssue,
} from "@open-bot/domain";
import { CdpPipe, type CdpEvent } from "./cdp";
import { terminate } from "./supervisor";
import { asUser, type SystemUser } from "./users";

/**
 * Pages on the computer: a preview server, so a teammate (and its browser) sees a draft exactly
 * as you will, and a checker that renders a page in a browser with no network, at a phone's width
 * and a laptop's, and says what's wrong with it.
 */

export const PAGE_PREVIEW_PORT = 7080;
const PREVIEW_ORIGIN = `http://127.0.0.1:${PAGE_PREVIEW_PORT}`;
/** The only folders pages are read from. */
const PAGE_ROOTS = [`${COMPUTER_PATHS.botsRoot}/`, `${COMPUTER_PATHS.shared}/`];
const MAX_ISSUES = 20;
const CHECK_TIMEOUT_MS = 40_000;
const MAX_CONCURRENT_CHECKS = 1;

export class PageFileError extends Error {}

/** The page file at `path`, read safely: only HTML in a workspace or the shared folder. */
export async function readPageFile(path: string): Promise<Buffer> {
  if (!isPageSourcePath(path))
    throw new PageFileError(
      `${path} isn't a page: give the full path of an .html file in your workspace or ${COMPUTER_PATHS.shared}.`,
    );
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new PageFileError(`There's no file at ${path}.`);
  }
  // A link can't lead out of the page folders (for example to the Codex sign-in).
  if (!PAGE_ROOTS.some((root) => real.startsWith(root)) || !isPageSourcePath(real))
    throw new PageFileError(`${path} points outside your workspace.`);
  const info = await stat(real);
  if (!info.isFile()) throw new PageFileError(`${path} isn't a file.`);
  if (info.size > MAX_PAGE_BYTES)
    throw new PageFileError(
      `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MB; pages can be up to ${MAX_PAGE_LABEL}. Make images smaller, or use SVG.`,
    );
  if (info.size === 0) throw new PageFileError(`${path} is empty.`);
  return readFile(real);
}

function decodeHtml(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new PageFileError("The page isn't UTF-8 text. Save it as UTF-8.");
  }
}

function sendHtml(response: http.ServerResponse, html: string) {
  response.writeHead(200, {
    ...PAGE_RESPONSE_HEADERS,
    "content-security-policy": pageContentSecurityPolicy(PREVIEW_ORIGIN, []),
    "cache-control": "no-store",
  });
  response.end(injectPageRuntime(html, `${PREVIEW_ORIGIN}${PAGE_RUNTIME_PATH}`));
}

/**
 * Serves drafts on the computer only: http://127.0.0.1:7080/preview?path=/home/bot/…/index.html.
 * Only requests addressed to that exact host are answered, so a website can't reach it by
 * pointing its own name at 127.0.0.1.
 */
export class PagePreviewServer {
  private readonly snapshots = new Map<string, string>();
  private server: http.Server | null = null;

  constructor(
    private readonly libDir: string,
    private readonly log: (message: string) => void,
  ) {}

  /** Serve this exact HTML at a one-off address while a check renders it. */
  snapshot(html: string): { url: string; release: () => void } {
    const id = randomUUID();
    this.snapshots.set(id, html);
    return {
      url: `${PREVIEW_ORIGIN}/snapshot/${id}?theme=light`,
      release: () => this.snapshots.delete(id),
    };
  }

  listen(): Promise<void> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.log(`[pages] preview failed: ${String(error)}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PAGE_PREVIEW_PORT, "127.0.0.1", () => resolve());
    });
  }

  close(): void {
    this.server?.close();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${PAGE_PREVIEW_PORT}` && host !== `localhost:${PAGE_PREVIEW_PORT}`) {
      response.writeHead(421).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const url = new URL(request.url ?? "/", PREVIEW_ORIGIN);
    if (url.pathname.startsWith("/lib/")) {
      const file = await readLibFile(this.libDir, url.pathname);
      if (!file) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      response.writeHead(200, file.headers).end(request.method === "HEAD" ? undefined : file.data);
      return;
    }
    const snapshot = /^\/snapshot\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (snapshot) {
      const html = this.snapshots.get(snapshot[1]!);
      if (html === undefined) response.writeHead(404).end();
      else sendHtml(response, html);
      return;
    }
    if (url.pathname === "/preview") {
      try {
        sendHtml(response, decodeHtml(await readPageFile(url.searchParams.get("path") ?? "")));
      } catch (error) {
        const message = error instanceof PageFileError ? error.message : "The page didn't open.";
        response
          .writeHead(error instanceof PageFileError ? 404 : 500, {
            "content-type": "text/plain; charset=utf-8",
          })
          .end(message);
      }
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

/** What the page reports about itself once it has settled, measured inside the browser. */
interface PageProbe {
  title: string;
  text: string;
  hasViewport: boolean;
  overflow: { width: number; offenders: string[] } | null;
  brokenImages: string[];
  undrawnDiagrams: number;
}

/**
 * Runs in the page: waits for fonts and for the page to stop changing, then measures it against
 * the device's width (a phone zooms out to fit a page that's too wide, so the window's own width
 * can't be trusted).
 */
const settleAndProbe = (width: number) => `(async (width) => {
  try { await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))]); } catch {}
  await new Promise((resolve) => {
    let timer = setTimeout(done, 600);
    const cap = setTimeout(done, 6000);
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 600); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() { observer.disconnect(); clearTimeout(cap); clearTimeout(timer); resolve(); }
  });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const scrollWidth = document.documentElement.scrollWidth;
  let overflow = null;
  if (scrollWidth > width + 2) {
    const offenders = [];
    const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p).overflowX; if (s === "auto" || s === "scroll" || s === "hidden" || s === "clip") return true; } return false; };
    for (const el of document.body.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= width + 2 || scrolls(el)) continue;
      const own = [...el.children].some(c => c.getBoundingClientRect().right > width + 2);
      if (own) continue;
      const name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
      offenders.push(name + " (" + Math.round(rect.right) + "px wide)");
      if (offenders.length >= 3) break;
    }
    overflow = { width: scrollWidth, offenders };
  }
  // All the text, hidden tabs and steps included, with breaks between blocks.
  const blocks = new Set(["ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","BR","DD","DETAILS","DIV","DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","H1","H2","H3","H4","H5","H6","HEADER","HR","LI","MAIN","NAV","OL","P","PRE","SECTION","SUMMARY","TABLE","TD","TH","TR","UL","BUTTON","CAPTION"]);
  const skip = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","OPENBOT-ASK"]);
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) parts.push(child.data);
      else if (child.nodeType === 1 && !skip.has(child.tagName)) {
        const block = blocks.has(child.tagName);
        if (block) parts.push("\\n");
        walk(child);
        if (block) parts.push("\\n");
        else if (child.tagName === "TD" || child.tagName === "SPAN") parts.push(" ");
      }
    }
  };
  if (document.body) walk(document.body);
  const text = parts.join("").replace(/[ \\t\\f\\v\\u00a0]+/g, " ").replace(/ *\\n[\\s]*/g, "\\n").trim();
  const brokenImages = [...document.images].filter(img => img.complete && img.naturalWidth === 0).map(img => (img.getAttribute("src") || "").slice(0, 120)).slice(0, 5);
  return {
    title: document.title.trim(),
    text: text.slice(0, ${MAX_PAGE_TEXT_CHARS}),
    hasViewport: Boolean(document.querySelector('meta[name="viewport"]')),
    overflow,
    brokenImages,
    undrawnDiagrams: document.querySelectorAll(".mermaid:not([data-processed])").length,
  };
})(${width})`;

/** Collects what goes wrong in a page while it loads, in words a teammate can act on. */
export class IssueLog {
  private readonly seen = new Set<string>();
  /** Addresses already reported, so the browser's several messages about one become one. */
  private readonly addresses = new Set<string>();
  readonly issues: PageIssue[] = [];

  constructor(private readonly previewHost: string) {}

  add(level: PageIssue["level"], message: string) {
    const text = message.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text || this.seen.has(text)) return;
    this.seen.add(text);
    if (this.issues.length < MAX_ISSUES) this.issues.push({ level, message: text });
  }

  /** Something the page tried to load or connect to that it can't. */
  blocked(address: string, connect = false) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return;
    }
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    const key = url.href.split("#")[0]!;
    if (this.addresses.has(key)) return;
    this.addresses.add(key);
    if (url.host !== this.previewHost)
      this.add(
        "error",
        connect
          ? `It connects to ${describeUrl(url.href)}, but pages can't use the network. Put the data in the file.`
          : `It loads ${describeUrl(url.href)} from the internet, which pages can't reach. Use the libraries in /lib, or put it in the file.`,
      );
    else if (url.pathname.startsWith("/lib/"))
      this.add("error", `There's no ${url.pathname} in the shared libraries.`);
    else
      this.add(
        "error",
        `It loads ${decodeURIComponent(url.pathname.replace(/^\/(?:snapshot\/)?/, "")) || "a file"} by a relative address, which only works on the computer. Put images in the file (data: URLs or inline SVG).`,
      );
  }
}

/** The address in a browser message about a page breaking its rules, and whether it's a connection. */
export function violationAddress(text: string): { url: string; connect: boolean } | null {
  if (!/Content Security Policy|violates/.test(text)) return null;
  const match =
    /'((?:https?|data|blob):[^']*)'/.exec(text) ?? /cannot load (\S+?)\.(?:\s|$)/.exec(text);
  if (!match) return null;
  return { url: match[1]!, connect: /Connecting to|Fetch API|connect to/.test(text) };
}

function describeUrl(url: string): string {
  return url.length > 140 ? `${url.slice(0, 137)}…` : url;
}

/**
 * Checks pages in a fresh headless Chromium each time. It runs as the desktop user, can reach
 * nothing but the preview server (every other address goes to a proxy that isn't there), and is
 * closed as soon as the check ends.
 */
export class PageChecker {
  private running = 0;
  get busy(): boolean {
    return this.running > 0 || this.queue.length > 0;
  }
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly preview: PagePreviewServer,
    private readonly user: SystemUser,
    private readonly browserSandbox: boolean,
    private readonly log: (message: string) => void,
  ) {}

  async check(path: string): Promise<PageCheckResult | PageCheckError> {
    let data: Buffer;
    let html: string;
    try {
      data = await readPageFile(path);
      html = decodeHtml(data);
    } catch (error) {
      if (error instanceof PageFileError) return { ok: false, message: error.message };
      throw error;
    }
    await this.slot();
    try {
      return await this.render(data, html);
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  private async slot() {
    if (this.running < MAX_CONCURRENT_CHECKS) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private async render(data: Buffer, html: string): Promise<PageCheckResult | PageCheckError> {
    const { url, release } = this.preview.snapshot(html);
    const issues = new IssueLog(new URL(url).host);
    if (!/^\s*<!doctype html/i.test(html))
      issues.add(
        "warning",
        "Start the file with <!doctype html>, or browsers lay it out in quirks mode.",
      );
    const profile = await mkdtemp("/tmp/botd-page-check-");
    await chown(profile, this.user.uid, this.user.gid);
    let browser: ChildProcess | null = null;
    let cdp: CdpPipe | null = null;
    const deadline = setTimeout(() => browser?.kill("SIGKILL"), CHECK_TIMEOUT_MS);
    try {
      const [command, args] = asUser(this.user, "chromium", [
        "--headless",
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-features=Translate,MediaRouter,OptimizationHints",
        "--hide-scrollbars",
        "--mute-audio",
        "--password-store=basic",
        "--force-color-profile=srgb",
        // No network: every address but the preview server goes to a proxy that isn't there.
        "--proxy-server=socks5://127.0.0.1:9",
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        ...(this.browserSandbox ? [] : ["--no-sandbox"]),
        "about:blank",
      ]);
      browser = spawn(command, args, {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
      const child = browser;
      const exited = new Promise<never>((_, reject) =>
        child.once("exit", () => reject(new Error("The browser closed while checking the page."))),
      );
      exited.catch(() => {});
      cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
      const pipe = cdp;
      await Promise.race([waitForBrowser(pipe), exited]);
      return await Promise.race([this.inspect(pipe, url, data, issues), exited]);
    } catch (error) {
      this.log(`[pages] check failed: ${String(error)}`);
      return {
        ok: false,
        message: `The page couldn't be checked: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(deadline);
      release();
      cdp?.close();
      if (browser) await terminate([browser]);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async inspect(
    pipe: CdpPipe,
    url: string,
    data: Buffer,
    issues: IssueLog,
  ): Promise<PageCheckResult> {
    const { targetId } = await pipe.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await pipe.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const send = <T>(method: string, params: Record<string, unknown> = {}, timeout = 10_000) =>
      pipe.send<T>(method, params, timeout, sessionId);

    const requests = new Map<string, string>();
    let loaded: () => void = () => {};
    const nextLoad = () => new Promise<void>((resolve) => (loaded = resolve));
    let load = nextLoad();
    const onEvent = (event: CdpEvent) => {
      if (event.sessionId !== sessionId) return;
      const params = event.params;
      switch (event.method) {
        case "Page.loadEventFired":
          loaded();
          break;
        case "Runtime.exceptionThrown": {
          const details = params.exceptionDetails as {
            text?: string;
            exception?: { description?: string };
            lineNumber?: number;
          };
          const description = details.exception?.description?.split("\n")[0] ?? details.text ?? "";
          issues.add(
            "error",
            `A script failed${details.lineNumber !== undefined ? ` (line ${details.lineNumber + 1})` : ""}: ${description}`,
          );
          break;
        }
        case "Runtime.consoleAPICalled": {
          if (params.type !== "error") break;
          const args = (params.args as { value?: unknown; description?: string }[]) ?? [];
          const text = args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
          issues.add("error", `The page logged an error: ${text}`);
          break;
        }
        case "Log.entryAdded": {
          const entry = params.entry as { level?: string; source?: string; text?: string };
          // Network failures are reported below, with the address.
          if (entry.level !== "error" || entry.source === "network") break;
          const violation = violationAddress(entry.text ?? "");
          if (violation) issues.blocked(violation.url, violation.connect);
          else issues.add("error", entry.text ?? "");
          break;
        }
        case "Network.requestWillBeSent": {
          const request = params.request as { url: string };
          requests.set(params.requestId as string, request.url);
          break;
        }
        case "Network.responseReceived": {
          const response = params.response as { url: string; status: number };
          if (response.status >= 400) issues.blocked(response.url);
          break;
        }
        case "Network.loadingFailed": {
          const requestUrl = requests.get(params.requestId as string) ?? "";
          if (/^https?:/.test(requestUrl))
            issues.blocked(requestUrl, params.type === "Fetch" || params.type === "XHR");
          break;
        }
      }
    };
    pipe.on("event", onEvent);
    try {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Log.enable");
      await send("Network.enable");
      await send("Emulation.setDeviceMetricsOverride", {
        width: PAGE_CHECK_WIDTHS.phone,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await send("Page.navigate", { url });
      await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      const phone = await probe(send, PAGE_CHECK_WIDTHS.phone);
      // Most of the page, so the teammate sees its diagrams and charts, not just the top.
      const phoneShot = await screenshot(send, PAGE_CHECK_WIDTHS.phone, 3200);

      await send("Emulation.setDeviceMetricsOverride", {
        width: PAGE_CHECK_WIDTHS.desktop,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const desktop = await probe(send, PAGE_CHECK_WIDTHS.desktop);
      const desktopShot = await screenshot(send, PAGE_CHECK_WIDTHS.desktop, 2400, 0.6);
      const thumbnail = await screenshot(send, PAGE_CHECK_WIDTHS.desktop, 800, 0.5);
      // The same view in the dark theme, for cards in a dark app. Anything that only breaks in
      // the dark theme is reported too.
      load = nextLoad();
      await send("Page.navigate", { url: url.replace("theme=light", "theme=dark") });
      await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      await probe(send, PAGE_CHECK_WIDTHS.desktop);
      const thumbnailDark = await screenshot(send, PAGE_CHECK_WIDTHS.desktop, 800, 0.5);

      if (!phone.title) issues.add("warning", "Give the page a <title>.");
      if (!phone.hasViewport)
        issues.add(
          "error",
          'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head, or phones show the page shrunk.',
        );
      if (phone.overflow)
        issues.add(
          "error",
          `On a phone (${PAGE_CHECK_WIDTHS.phone}px) the page is ${phone.overflow.width}px wide, so it scrolls sideways${phone.overflow.offenders.length ? `: ${phone.overflow.offenders.join(", ")}` : ""}. Let wide things wrap, or put them in a scrolling box (.table-wrap, .diagram).`,
        );
      if (desktop.overflow)
        issues.add(
          "warning",
          `At ${PAGE_CHECK_WIDTHS.desktop}px the page is ${desktop.overflow.width}px wide${desktop.overflow.offenders.length ? `: ${desktop.overflow.offenders.join(", ")}` : ""}.`,
        );
      // Images that failed to load were reported with their address; these are the ones in the file.
      for (const src of phone.brokenImages.filter((src) => src.startsWith("data:") || !src))
        issues.add(
          "error",
          `An image in the file doesn't show: ${src.slice(0, 60) || "(no src)"}.`,
        );
      if (phone.undrawnDiagrams)
        issues.add(
          "error",
          `${phone.undrawnDiagrams} Mermaid diagram${phone.undrawnDiagrams === 1 ? "" : "s"} didn't draw. Load /lib/mermaid@12/mermaid.min.js and /lib/kit@1/kit.js, and check the diagram syntax.`,
        );
      if (phone.text.length < 40)
        issues.add("warning", "The page has almost no text. Is that what you meant?");
      if (data.length > 2 * 1024 * 1024)
        issues.add(
          "warning",
          `The page is ${(data.length / 1024 / 1024).toFixed(1)} MB, which is slow on a phone. Make images smaller.`,
        );

      return {
        ok: true,
        htmlBase64: data.toString("base64"),
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        title: phone.title,
        text: desktop.text || phone.text,
        issues: issues.issues,
        screenshots: { phone: phoneShot, desktop: desktopShot },
        thumbnail,
        thumbnailDark,
      };
    } finally {
      pipe.off("event", onEvent);
    }
  }
}

async function waitForBrowser(pipe: CdpPipe) {
  const started = Date.now();
  for (;;) {
    try {
      await pipe.send("Browser.getVersion", {}, 2_000);
      return;
    } catch (error) {
      if (!pipe.isOpen || Date.now() - started > 15_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

type Send = <T>(method: string, params?: Record<string, unknown>, timeout?: number) => Promise<T>;

async function probe(send: Send, width: number): Promise<PageProbe> {
  const result = await send<{
    result: { value?: PageProbe };
    exceptionDetails?: { text?: string };
  }>(
    "Runtime.evaluate",
    { expression: settleAndProbe(width), awaitPromise: true, returnByValue: true },
    15_000,
  );
  if (!result.result.value)
    throw new Error(result.exceptionDetails?.text ?? "The page couldn't be measured.");
  return result.result.value;
}

/**
 * A JPEG of the page from the top: `height` pixels of it (beyond the screen when the page is that
 * long), shrunk by `scale`.
 */
async function screenshot(send: Send, width: number, height: number, scale = 1): Promise<string> {
  const { result } = await send<{ result: { value?: number } }>("Runtime.evaluate", {
    expression: "document.documentElement.scrollHeight",
    returnByValue: true,
  });
  const pageHeight = Math.max(1, Math.min(height, result.value ?? height));
  const { data } = await send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: 74,
      captureBeyondViewport: pageHeight > 900,
      clip: { x: 0, y: 0, width, height: pageHeight, scale },
    },
    20_000,
  );
  return data;
}
