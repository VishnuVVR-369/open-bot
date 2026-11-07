/**
 * Passkey names people can tell apart: "Chrome on Mac", "Safari on iPhone". Older passkeys were
 * named with the browser's raw platform string ("MacIntel", "Win32"), so those read as the
 * device too.
 */

function device(userAgent: string): string | null {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "Chromebook";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

function browser(userAgent: string): string | null {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

/** The name a new passkey gets, from the browser that creates it. */
export function passkeyNameFor(userAgent: string): string {
  const where = device(userAgent);
  const app = browser(userAgent);
  if (app && where) return `${app} on ${where}`;
  return where ?? app ?? "This device";
}

/** Raw `navigator.platform` values older passkeys were named with. */
const PLATFORMS: [RegExp, string][] = [
  [/^Mac(Intel|PPC|68K)$/, "Mac"],
  [/^Win(32|64|CE)$/, "Windows"],
  [/^(iPhone|iPad|iPod)$/, "$1"],
  [/^Linux (arm|aarch)\w*$/, "Android"],
  [/^Linux( \w+)?$/, "Linux"],
];

/** How a saved passkey is shown. */
export function passkeyLabel(name: string | null | undefined): string {
  const value = name?.trim();
  if (!value) return "Passkey";
  const raw = PLATFORMS.find(([pattern]) => pattern.test(value));
  return raw ? value.replace(raw[0], raw[1]) : value;
}
