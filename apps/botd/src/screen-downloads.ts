import type { CdpEvent } from "./cdp";

/** The browser downloads a screen has in progress. A screen with one is never stopped. */
export class ScreenDownloads {
  private readonly active = new Set<string>();
  /** Called when the last download ends, so a start waiting for room can stop the screen now. */
  onDone?: () => void;

  get busy(): boolean {
    return this.active.size > 0;
  }

  /** Track a browser event if it is about a download; returns whether it was one. */
  handle(event: CdpEvent): boolean {
    if (event.method === "Browser.downloadWillBegin") {
      this.active.add((event.params as { guid: string }).guid);
      return true;
    }
    if (event.method === "Browser.downloadProgress") {
      const { guid, state } = event.params as { guid: string; state: string };
      const ended = (state === "completed" || state === "canceled") && this.active.delete(guid);
      if (ended && !this.active.size) this.onDone?.();
      return true;
    }
    return false;
  }
}
