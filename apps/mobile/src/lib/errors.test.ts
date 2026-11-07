import { createApiClient } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import { errorMessage, FileError, isGone, isNotFound, isRetryable, isUnauthorized } from "./errors";

/** What the real client throws when the server answers with `response`. */
async function failure(response: () => Response): Promise<unknown> {
  const api = createApiClient({ appUrl: "https://open-bot.test", fetch: async () => response() });
  return api.teammates.list().then(
    () => expect.unreachable("the call should fail"),
    (error: unknown) => error,
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("call errors", () => {
  it("says the server is out of date when it has no API to answer with", async () => {
    const error = await failure(
      () => new Response("<!DOCTYPE html><html></html>", { status: 404 }),
    );
    expect(errorMessage(error)).toMatch(/out of date/);
    expect(isRetryable(error)).toBe(false);
    // Not the chat that's missing: the whole API.
    expect(isGone(error)).toBe(false);
  });

  it("uses the server's words for its own errors, and doesn't retry them", async () => {
    const error = await failure(() =>
      json(404, {
        json: {
          defined: true,
          code: "NOT_FOUND",
          status: 404,
          message: "That chat no longer exists.",
        },
      }),
    );
    expect(errorMessage(error)).toBe("That chat no longer exists.");
    expect(isRetryable(error)).toBe(false);
    expect(isGone(error)).toBe(true);
    expect(isNotFound(error)).toBe(true);
  });

  it("reads a link whose id was turned down as not found, not as worth retrying", async () => {
    const error = await failure(() =>
      json(400, {
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: "Input validation failed",
        },
      }),
    );
    expect(isNotFound(error)).toBe(true);
    expect(isRetryable(error)).toBe(false);
    const offline = new TypeError("Network request failed");
    expect(isNotFound(offline)).toBe(false);
  });

  it("spots a lost session", async () => {
    const error = await failure(() =>
      json(401, {
        json: { defined: false, code: "UNAUTHORIZED", status: 401, message: "Sign in." },
      }),
    );
    expect(isUnauthorized(error)).toBe(true);
    expect(isRetryable(error)).toBe(false);
  });

  it("retries when the server or the connection failed", async () => {
    const error = await failure(() => new Response("Bad gateway", { status: 502 }));
    expect(isRetryable(error)).toBe(true);
    expect(errorMessage(error)).toMatch(/isn't answering right now/);

    const offline = new TypeError("Network request failed");
    expect(isRetryable(offline)).toBe(true);
    expect(errorMessage(offline)).toMatch(/Couldn't reach open-bot/);
  });
});

describe("file errors", () => {
  it("says why a file couldn't be opened, and doesn't ask again for a missing one", () => {
    const missing = new FileError(404, "That file isn't there anymore.");
    expect(errorMessage(missing)).toBe("That file isn't there anymore.");
    expect(isRetryable(missing)).toBe(false);
  });

  it("spots a lost session, and retries when the server failed", () => {
    expect(isUnauthorized(new FileError(401, "Sign in first."))).toBe(true);
    const failed = new FileError(503, "The worker isn't running.");
    expect(isRetryable(failed)).toBe(true);
    expect(errorMessage(failed)).toBe("Something went wrong.");
  });
});
