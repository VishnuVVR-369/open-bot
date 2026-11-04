// The only browser code in the native app. Bundled locally, never loaded from the server.
// @ts-expect-error noVNC has no TypeScript declarations.
import RFB from "@novnc/novnc";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}
const host = document.getElementById("host")!;
const cursor = document.getElementById("cursor")!;
let rfb: InstanceType<typeof RFB> | null = null;
let generation = 0;
let control = false;
let trackpad = false;
let zoom = 1;
let pan = { x: 0, y: 0 };
// The pointer lives in a fixed 1280x800 space, mapped onto the canvas wherever it is drawn.
const pointer = { x: 640, y: 400 };
let lastActivity = 0;
let dragging = false;
let pinching = false;
let gesture: {
  x: number;
  y: number;
  distance: number;
  moved: boolean;
  at: number;
  fingers: number;
} | null = null;
const modifiers = new Map<string, number>();
const emit = (type: string, detail: Record<string, unknown> = {}) =>
  window.ReactNativeWebView.postMessage(
    JSON.stringify({ version: 1, generation, type, ...detail }),
  );

function activity() {
  if (control && Date.now() - lastActivity > 1000) {
    lastActivity = Date.now();
    emit("activity");
  }
}
function transform() {
  pan.x = Math.min(0, Math.max(host.clientWidth * (1 - zoom), pan.x));
  pan.y = Math.min(0, Math.max(host.clientHeight * (1 - zoom), pan.y));
  host.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
}
function mouse(type: string, button = 0) {
  const canvas = host.querySelector("canvas");
  if (!canvas || !control) return;
  const box = canvas.getBoundingClientRect();
  const clientX = box.left + (pointer.x / 1280) * box.width;
  const clientY = box.top + (pointer.y / 800) * box.height;
  canvas.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      clientX,
      clientY,
      button,
      buttons: type === "mousedown" ? ([1, 4, 2][button] ?? 0) : 0,
    }),
  );
  cursor.style.left = `${clientX - 9}px`;
  cursor.style.top = `${clientY - 9}px`;
}
function releaseInput() {
  if (rfb && control) for (const [code, sym] of modifiers) rfb.sendKey(sym, code, false);
  modifiers.clear();
  mouse("mouseup");
}
function disconnect() {
  releaseInput();
  try {
    rfb?.disconnect();
  } catch {
    /* Already disconnected. */
  }
  rfb = null;
  host.replaceChildren();
}

function receive(event: MessageEvent) {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  if (data.version !== 1 || typeof data.generation !== "number") return;
  if (data.type === "connect") {
    disconnect();
    generation = data.generation;
    if (
      typeof data.url !== "string" ||
      typeof data.token !== "string" ||
      typeof data.screenId !== "string"
    )
      return;
    const url = new URL(data.url);
    if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password) return;
    control = data.mode === "control";
    trackpad = false;
    zoom = 1;
    pan = { x: 0, y: 0 };
    transform();
    url.pathname = `${url.pathname.replace(/\/$/, "")}/vnc`;
    url.search = new URLSearchParams({
      token: data.token,
      screen: data.screenId,
      mode: control ? "control" : "view",
    }).toString();
    rfb = new RFB(host, url.toString(), { wsProtocols: ["binary"], shared: true });
    rfb.viewOnly = !control;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = false;
    // Match the native frame, so letterboxing reads as part of it.
    rfb.background = "#101117";
    rfb.qualityLevel = 7;
    rfb.compressionLevel = 2;
    const connection = rfb;
    rfb.addEventListener("connect", () => {
      if (rfb === connection) emit("connected");
    });
    rfb.addEventListener("disconnect", () => {
      if (rfb === connection) {
        releaseInput();
        emit("disconnected");
      }
    });
    return;
  }
  if (data.generation !== generation) return;
  if (data.type === "disconnect") {
    disconnect();
    return;
  }
  if (data.type === "fit") {
    zoom = 1;
    pan = { x: 0, y: 0 };
    transform();
    return;
  }
  if (!control || !rfb) return;
  if (data.type === "pointerMode") {
    trackpad = data.trackpad === true;
    cursor.style.display = trackpad ? "block" : "none";
    mouse("mousemove");
  }
  if (data.type === "key" && typeof data.keysym === "number" && typeof data.code === "string") {
    rfb.sendKey(data.keysym, data.code, typeof data.down === "boolean" ? data.down : undefined);
    if (data.down === true) modifiers.set(data.code, data.keysym);
    else modifiers.delete(data.code);
    activity();
  }
  if (data.type === "text" && typeof data.text === "string" && data.text.length <= 5000) {
    for (const char of data.text) {
      // Line breaks and tabs are keys, not characters, on X11. A CRLF pastes one Enter.
      if (char === "\r") continue;
      if (char === "\n") rfb.sendKey(0xff0d, "Enter");
      else if (char === "\t") rfb.sendKey(0xff09, "Tab");
      else {
        const point = char.codePointAt(0)!;
        rfb.sendKey(point > 255 ? 0x1000000 | point : point, null);
      }
    }
    activity();
  }
}
document.addEventListener("message", receive as EventListener);
window.addEventListener("message", receive);

// Own touch arbitration so a pinch can never become remote browser zoom or a stray click.
function place(clientX: number, clientY: number) {
  const box = host.querySelector("canvas")?.getBoundingClientRect();
  if (!box) return;
  pointer.x = Math.max(0, Math.min(1279, ((clientX - box.left) / box.width) * 1280));
  pointer.y = Math.max(0, Math.min(799, ((clientY - box.top) / box.height) * 800));
}
document.addEventListener(
  "touchstart",
  (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const a = event.touches[0];
    if (!a) return;
    const b = event.touches[1];
    if (dragging) {
      mouse("mouseup");
      dragging = false;
    }
    gesture = {
      x: a.clientX,
      y: a.clientY,
      distance: b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0,
      moved: false,
      at: Date.now(),
      fingers: event.touches.length,
    };
    pinching = false;
    activity();
  },
  { capture: true, passive: false },
);
document.addEventListener(
  "touchmove",
  (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const a = event.touches[0];
    if (!gesture || !a) return;
    const b = event.touches[1];
    const dx = a.clientX - gesture.x,
      dy = a.clientY - gesture.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true;
    if (b && gesture.distance > 0) {
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinching || Math.abs(distance - gesture.distance) > 5) {
        pinching = true;
        const old = zoom;
        zoom = Math.max(1, Math.min(4, (zoom * distance) / gesture.distance));
        const cx = (a.clientX + b.clientX) / 2,
          cy = (a.clientY + b.clientY) / 2;
        pan.x = cx - ((cx - pan.x) * zoom) / old;
        pan.y = cy - ((cy - pan.y) * zoom) / old;
        transform();
      } else if (control) {
        host.querySelector("canvas")?.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            clientX: a.clientX,
            clientY: a.clientY,
            deltaX: -dx,
            deltaY: -dy,
            deltaMode: 0,
          }),
        );
      } else {
        pan.x += dx;
        pan.y += dy;
        transform();
      }
      gesture.distance = distance;
    } else if (trackpad && control) {
      const box = host.querySelector("canvas")?.getBoundingClientRect();
      if (box) {
        pointer.x = Math.max(0, Math.min(1279, pointer.x + (dx * 1280) / box.width));
        pointer.y = Math.max(0, Math.min(799, pointer.y + (dy * 800) / box.height));
        mouse("mousemove");
      }
    } else if (!control) {
      pan.x += dx;
      pan.y += dy;
      transform();
    } else {
      if (!dragging) {
        place(gesture.x, gesture.y);
        mouse("mousedown");
        dragging = true;
      }
      place(a.clientX, a.clientY);
      mouse("mousemove");
    }
    gesture.x = a.clientX;
    gesture.y = a.clientY;
    activity();
  },
  { capture: true, passive: false },
);
document.addEventListener(
  "touchend",
  (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (dragging) {
      mouse("mouseup");
      dragging = false;
    }
    if (control && gesture && !gesture.moved && gesture.fingers === 1) {
      if (!trackpad) place(gesture.x, gesture.y);
      const button = Date.now() - gesture.at > 500 ? 2 : 0;
      mouse("mousemove");
      mouse("mousedown", button);
      mouse("mouseup", button);
      activity();
    }
    if (!event.touches.length) gesture = null;
  },
  { capture: true, passive: false },
);
document.addEventListener(
  "touchcancel",
  () => {
    gesture = null;
    dragging = false;
    releaseInput();
  },
  { capture: true },
);
window.addEventListener("blur", releaseInput);
emit("ready");
