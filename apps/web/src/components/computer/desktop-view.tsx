"use client";

import { Loader2, MonitorOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { reportScreenActivity } from "@/lib/actions";
import { cn } from "@/lib/utils";

type Rfb = {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  clipViewport: boolean;
  focusOnClick: boolean;
  qualityLevel: number;
  compressionLevel: number;
  background: string;
  disconnect(): void;
  focus(): void;
  clipboardPasteFrom(text: string): void;
  sendCtrlAltDel(): void;
  addEventListener(type: string, listener: (event: CustomEvent) => void): void;
};

export type DesktopConnection = "connecting" | "connected" | "offline";

export interface DesktopHandle {
  pasteText: (text: string) => void;
  focus: () => void;
}

const ACTIVITY_INTERVAL_MS = 30_000;

/**
 * A bot's screen over VNC. `view` can only watch; `control` sends your mouse and keyboard.
 * The worker enforces this: a control connection is refused unless you hold the screen.
 */
export function DesktopView({
  screenId,
  mode,
  className,
  onStatus,
  handleRef,
}: {
  screenId: string;
  mode: "view" | "control";
  className?: string;
  onStatus?: (status: DesktopConnection) => void;
  handleRef?: React.RefObject<DesktopHandle | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<DesktopConnection>("connecting");
  const [attempt, setAttempt] = useState(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    onStatusRef.current?.(status);
  }, [status]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let rfb: Rfb | null = null;
    let disposed = false;
    // noVNC throws if you disconnect an object that already disconnected.
    let rfbClosed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    setStatus("connecting");

    (async () => {
      try {
        const response = await fetch("/api/desktop/token", { cache: "no-store" });
        if (!response.ok) throw new Error("No token");
        const { url, token } = (await response.json()) as { url: string; token: string };
        const { default: RFB } = (await import("@novnc/novnc")) as unknown as {
          default: new (
            target: HTMLElement,
            url: string,
            options?: { wsProtocols?: string[]; shared?: boolean },
          ) => Rfb;
        };
        if (disposed) return;
        host.replaceChildren();
        const query = new URLSearchParams({ screen: screenId, mode, token });
        rfb = new RFB(host, `${url}/vnc?${query}`, {
          wsProtocols: ["binary"],
          shared: true,
        });
        rfb.viewOnly = mode === "view";
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.focusOnClick = mode === "control";
        rfb.qualityLevel = 7;
        rfb.compressionLevel = 2;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => {
          if (disposed) return;
          setStatus("connected");
          // Ready for your keyboard, unless you're typing somewhere else, like the hand-back note.
          const focused = document.activeElement;
          if (
            mode === "control" &&
            (!focused || focused === document.body || host.contains(focused))
          )
            rfb?.focus();
        });
        rfb.addEventListener("disconnect", () => {
          rfbClosed = true;
          if (disposed) return;
          setStatus("offline");
          retry = setTimeout(() => setAttempt((n) => n + 1), 2_000);
        });
        rfb.addEventListener("clipboard", (event) => {
          const text = (event.detail as { text?: string }).text;
          if (mode === "control" && text && document.hasFocus())
            void navigator.clipboard?.writeText(text).catch(() => {});
        });
        if (handleRef) {
          handleRef.current = {
            pasteText: (text) => rfb?.clipboardPasteFrom(text),
            focus: () => rfb?.focus(),
          };
        }
      } catch {
        if (disposed) return;
        setStatus("offline");
        retry = setTimeout(() => setAttempt((n) => n + 1), 3_000);
      }
    })();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (rfb && !rfbClosed) rfb.disconnect();
      if (handleRef) handleRef.current = null;
    };
  }, [screenId, mode, attempt, handleRef]);

  // While you have control, tell the computer you're active, so it doesn't hand control back for inactivity.
  useEffect(() => {
    if (mode !== "control") return;
    const host = hostRef.current;
    if (!host) return;
    let last = 0;
    const onInput = () => {
      const now = Date.now();
      if (now - last < ACTIVITY_INTERVAL_MS) return;
      last = now;
      void reportScreenActivity(screenId);
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
    for (const type of events) host.addEventListener(type, onInput, { passive: true });
    return () => {
      for (const type of events) host.removeEventListener(type, onInput);
    };
  }, [screenId, mode]);

  return (
    <div className={cn("relative h-full w-full", className)}>
      <div
        ref={hostRef}
        className={cn("novnc-host absolute inset-0", mode === "view" && "pointer-events-none")}
        data-testid="desktop-canvas"
      />
      {status !== "connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-bezel-foreground/70">
          {status === "connecting" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <>
              <MonitorOff className="size-5" />
              <span className="text-[13px]">Reconnecting to the screen…</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
