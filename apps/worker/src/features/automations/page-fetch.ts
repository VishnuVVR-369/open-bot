// Fetching a watched page safely: public addresses only, a size and time limit, few redirects.
import { lookup } from "node:dns/promises";
import { isPrivateAddress, pageText } from "@open-bot/domain";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Why a page couldn't be fetched, in plain words. */
function fetchFailure(error: unknown, url: URL): string {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "The page took too long to answer.";
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Couldn't find ${url.hostname}.`;
  if (code === "ECONNREFUSED") return `Nothing answered at ${url.host}.`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "The connection was cut off.";
  if (code.startsWith("UND_ERR_CONNECT_TIMEOUT") || code === "ETIMEDOUT")
    return "The page took too long to answer.";
  if (/CERT|SSL|TLS/i.test(code)) return "The page's security certificate isn't valid.";
  if (cause?.message === "bad port") return `Browsers don't allow port ${url.port}.`;
  return "Couldn't reach the page.";
}

/** The page's text, following redirects and refusing private network addresses. */
export async function fetchPage(start: string, allowPrivate: boolean): Promise<string> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublic(url, allowPrivate);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    }).catch((error: unknown) => {
      throw new Error(fetchFailure(error, url));
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location)
        throw new Error(`The page redirected (${response.status}) without saying where.`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok)
      throw new Error(`The page answered ${response.status} ${response.statusText}.`);
    const body = await readLimited(response);
    return pageText(body, response.headers.get("content-type") ?? "");
  }
  throw new Error("The page redirected too many times.");
}

async function assertPublic(url: URL, allowPrivate: boolean) {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http and https pages can be watched.");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true }).catch(() => {
    throw new Error(`Couldn't find ${host}.`);
  });
  if (addresses.some((entry) => isPrivateAddress(entry.address)))
    throw new Error("Pages on a private network can't be watched.");
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
