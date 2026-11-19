import { describe, expect, it } from "vitest";
import { MAX_JSON_DEPTH, headersKeyAt, redactRawResponse, redactedJson } from "./redact";
import { ERROR_TOO_DEEP, rebuildResponse } from "./response";
import { WebSocketResponseReader } from "./websocket";

/** A wrapped WebSocket error as ChatGPT sends it, with credentials in its headers. */
const wrapped = {
  type: "error",
  status: 429,
  error: { type: "usage_limit_reached", headers: { "x-session-token": "nested-secret" } },
  headers: {
    "set-cookie": "session=cookie-secret",
    "chatgpt-account-id": "account-secret",
    "x-codex-primary-used-percent": "100",
  },
};
const SECRETS = /nested-secret|cookie-secret|account-secret/;
const created = '{"type":"response.created","response":{"id":"resp-1"}}';
const pretty = JSON.stringify(wrapped, null, 2);

/** An error event with no message of its own, its envelope nested `depth` objects deep. */
function deepError(depth: number): string {
  const nested = '{"m":'.repeat(depth) + "1" + "}".repeat(depth);
  return `{"type":"error","status":400,"error":{"type":"invalid_request_error","metadata":${nested}},"headers":{"set-cookie":"session=cookie-secret"}}`;
}

describe("redactedJson", () => {
  it("strips credentials and the account from every header object, keeping the rest", () => {
    const redacted = redactedJson(wrapped)!;
    expect(redacted.changed).toBe(true);
    expect(JSON.parse(redacted.text)).toEqual({
      type: "error",
      status: 429,
      error: { type: "usage_limit_reached", headers: {} },
      headers: { "x-codex-primary-used-percent": "100" },
    });
    const clean = { type: "response.created", response: { id: "resp-1" } };
    expect(redactedJson(clean)).toEqual({ text: JSON.stringify(clean), changed: false });
  });

  it("leaves out a header value that isn't an object, in any case of its key", () => {
    const value = { Headers: ["set-cookie", "cookie-secret"], error: { HEADERS: "cookie-secret" } };
    expect(JSON.parse(redactedJson(value)!.text)).toEqual({ error: {} });
  });

  it("gives up on a value nested deeper than it walks, without recursing", () => {
    expect(redactedJson(JSON.parse(deepError(MAX_JSON_DEPTH)))).toBeNull();
    expect(redactedJson(JSON.parse(deepError(1_000_000)))).toBeNull();
    expect(redactedJson(JSON.parse(deepError(10)))).not.toBeNull();
  });
});

describe("headersKeyAt", () => {
  it("finds a headers key plainly written or escaped, but not one inside a string", () => {
    expect(headersKeyAt('{"a":1,"Headers" : {')).toBe(7);
    expect(headersKeyAt('{"a":1,"h\\u0065aders":{')).toBe(7);
    expect(headersKeyAt('{"message":"{\\"headers\\":1}"}')).toBe(-1);
  });
});

describe("redactRawResponse", () => {
  it("reads each WebSocket message on its own, pretty-printed ones included", () => {
    const stored = redactRawResponse([created, pretty, JSON.stringify(wrapped)], null);
    expect(stored.text).not.toMatch(SECRETS);
    expect(stored.cut).toBe(false);
    const [first, second] = stored.text.split("\n");
    expect(first).toBe(created);
    expect(JSON.parse(second!)).toMatchObject({ status: 429, headers: {} });
  });

  it("redacts a short, whole response whose one pretty-printed event spans lines", () => {
    // The council's case: 256 bytes or so, nothing cut, one event over several lines.
    const event = JSON.stringify(
      {
        type: "error",
        headers: { "set-cookie": "s=cookie-secret", "chatgpt-account-id": "account-secret" },
      },
      null,
      1,
    );
    const messages = [created, event, '{"type":"response.failed","response":{"id":"resp-1"}}'];
    expect(messages.join("\n").length).toBeLessThan(300);
    const stored = redactRawResponse(messages, null);
    expect(stored.text).not.toMatch(SECRETS);
    expect(stored.text.split("\n")[2]).toBe(messages[2]);
  });

  it("drops a cut message from its first headers key to its end, the lines after it included", () => {
    const cut = pretty.slice(0, pretty.indexOf("account-secret") + 3);
    const stored = redactRawResponse([created, cut], null);
    expect(stored.text).not.toMatch(SECRETS);
    expect(stored.text).not.toContain("x-codex-primary-used-percent");
    expect(stored).toEqual({
      text: `${created}\n${cut.slice(0, cut.indexOf('"headers"'))}`,
      cut: true,
    });
  });

  it("reads an event stream event by event, its data lines as one", () => {
    const multiline = pretty
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n");
    const clean = `event: response.created\r\ndata: ${created}\r\n\r\n`;
    const body = `${clean}event: error\n${multiline}\n\n: keep-alive\n\n`;
    const stored = redactRawResponse(body, "text/event-stream");
    expect(stored.text).not.toMatch(SECRETS);
    expect(stored.cut).toBe(false);
    // What had nothing to redact is kept byte for byte.
    expect(stored.text.startsWith(clean)).toBe(true);
    expect(stored.text.endsWith("\n\n: keep-alive\n\n")).toBe(true);
    const event = stored.text.slice(clean.length).split("\n\n")[0]!;
    expect(event.split("\n")[0]).toBe("event: error");
    expect(JSON.parse(event.split("\n")[1]!.slice("data: ".length))).toMatchObject({
      headers: { "x-codex-primary-used-percent": "100" },
    });
  });

  it("drops a cut event's data from its first headers key on, and sniffs a stream without a type", () => {
    const lines = pretty.split("\n").map((line) => `data: ${line}`);
    const keep = lines.findIndex((line) => line.includes("account-secret"));
    const body = `data: ${created}\n\nevent: error\n${lines.slice(0, keep + 1).join("\n")}`;
    const stored = redactRawResponse(body, null);
    expect(stored.text).not.toMatch(SECRETS);
    expect(stored.cut).toBe(true);
    const data = lines.map((line) => line.slice("data: ".length)).join("\n");
    const before = data.slice(0, data.indexOf('"headers"')).split("\n");
    expect(stored.text).toBe(
      `data: ${created}\n\nevent: error\n${before.map((line) => `data: ${line}`).join("\n")}`,
    );
  });

  it("cuts a line outside the data, and a body that isn't an event stream, at a headers key", () => {
    const comment = redactRawResponse(
      `: {"headers":{"set-cookie":"cookie-secret"}}\ndata: {}\n\n`,
      null,
    );
    expect(comment).toEqual({ text: ": {\ndata: {}\n\n", cut: true });
    // A pretty-printed JSON body cut by the raw limit: one unit, so the lines after the cut go too.
    const body = JSON.stringify({ note: "slow down", ...wrapped }, null, 2);
    const cut = body.slice(0, body.indexOf("account-secret") + 3);
    const stored = redactRawResponse(cut, "application/json");
    expect(stored).toEqual({ text: cut.slice(0, cut.indexOf('"headers"')), cut: true });
    // Whole, it is read and redacted.
    expect(JSON.parse(redactRawResponse(body, "application/json").text)).toMatchObject({
      headers: { "x-codex-primary-used-percent": "100" },
    });
    // A key spelled with escapes counts too.
    const escaped = '{"h\\u0065aders":{"set-cookie":"cookie-secret"}';
    expect(redactRawResponse(escaped, null)).toEqual({ text: "{", cut: true });
  });

  it("cuts a message nested too deep to redact, without throwing", () => {
    const stored = redactRawResponse([deepError(3000)], null);
    expect(stored.cut).toBe(true);
    expect(stored.text).not.toMatch(SECRETS);
    expect(stored.text.length).toBeLessThan(deepError(3000).indexOf('"headers"') + 1);
  });
});

describe("errors with no message of their own", () => {
  it("leave credentials out of the envelope that stands in", () => {
    const rebuilt = rebuildResponse(JSON.stringify(wrapped), "application/json");
    expect(rebuilt.error?.type).toBe("usage_limit_reached");
    expect(rebuilt.error?.message).not.toMatch(SECRETS);
  });

  it("are read over HTTP and WebSocket however deep their envelope nests", () => {
    // 3,000 nested objects overflowed the stack when the envelope was redacted recursively.
    const event = deepError(3000);
    const sse = rebuildResponse(`event: error\ndata: ${event}\n\n`, "text/event-stream");
    expect(sse.error).toEqual({ type: "invalid_request_error", message: ERROR_TOO_DEEP });
    expect(sse.warnings).toContain(ERROR_TOO_DEEP);
    expect(rebuildResponse(event, "application/json").error?.message).toBe(ERROR_TOO_DEEP);

    const reader = new WebSocketResponseReader(1024 * 1024);
    // The event is still given back, so the caller can tell the response ended.
    expect(reader.message(event)).toMatchObject({ type: "error", status: 400 });
    expect(reader.end().response.error?.message).toBe(ERROR_TOO_DEEP);
  });
});
