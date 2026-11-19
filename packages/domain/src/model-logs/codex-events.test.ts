import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_FILE_REDACTED,
  codexEventRefs,
  isDeltaMethod,
  MAX_EVENT_STRING,
  MAX_EVENT_NODES,
  redactCodexPayload,
  UnstorablePayload,
} from "./codex-events";
import { isSecretKey, REDACTED } from "./secret-text";

// A JWT shaped like a ChatGPT access token (header and payload are base64url JSON).
const JWT =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE5MzQ0ZTY1In0.eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdfQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
const API_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

/** Every string anywhere in a value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("isDeltaMethod", () => {
  it("matches every streaming delta in Codex 0.162.1's notifications", () => {
    for (const method of [
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/plan/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "command/exec/outputDelta",
      "process/outputDelta",
      "thread/realtime/transcript/delta",
      "thread/realtime/outputAudio/delta",
    ])
      expect(isDeltaMethod(method), method).toBe(true);
  });

  it("keeps completed items, turns and everything else", () => {
    for (const method of [
      "item/completed",
      "item/started",
      "turn/completed",
      "thread/tokenUsage/updated",
      "turn/diff/updated",
      "item/reasoning/summaryPartAdded",
      "item/tool/call",
    ])
      expect(isDeltaMethod(method), method).toBe(false);
  });
});

describe("codexEventRefs", () => {
  it("reads a notification's thread, turn and item", () => {
    expect(
      codexEventRefs({
        threadId: "thr",
        turnId: "turn",
        item: { type: "commandExecution", id: "call_1", status: "completed" },
      }),
    ).toEqual({ threadId: "thr", turnId: "turn", itemId: "call_1" });
  });

  it("reads a dynamic tool call's call id as its item", () => {
    expect(
      codexEventRefs({
        threadId: "thr",
        turnId: "turn",
        callId: "call_9",
        namespace: null,
        tool: "send_message",
        arguments: {},
      }),
    ).toEqual({ threadId: "thr", turnId: "turn", itemId: "call_9" });
  });

  it("reads thread/start and turn/start results, and turn/steer's expected turn", () => {
    expect(codexEventRefs({ thread: { id: "thr" } }).threadId).toBe("thr");
    expect(codexEventRefs({ turn: { id: "turn", status: "inProgress" } }).turnId).toBe("turn");
    expect(codexEventRefs({ threadId: "thr", expectedTurnId: "turn" }).turnId).toBe("turn");
    expect(codexEventRefs(null)).toEqual({ threadId: null, turnId: null, itemId: null });
  });
});

describe("isSecretKey", () => {
  it("names credentials, not token counts", () => {
    for (const key of [
      "accessToken",
      "refresh_token",
      "id_token",
      "token",
      "experimental_bearer_token",
      "apiKey",
      "api_key",
      "OPENAI_API_KEY",
      "client_secret",
      "password",
      "Authorization",
      "Cookie",
      "chatgptAccountId",
      "tokens",
    ])
      expect(isSecretKey(key), key).toBe(true);
    for (const key of ["inputTokens", "tokenUsage", "max_output_tokens", "model", "threadId"])
      expect(isSecretKey(key), key).toBe(false);
  });
});

describe("redactCodexPayload", () => {
  it("redacts account/login/start's ChatGPT tokens", () => {
    const params = {
      type: "chatgptAuthTokens",
      accessToken: JWT,
      chatgptAccountId: "acct-1234",
      chatgptPlanType: "pro",
    };
    const stored = redactCodexPayload("account/login/start", params);
    expect(stored).toEqual({
      type: "chatgptAuthTokens",
      accessToken: REDACTED,
      chatgptAccountId: REDACTED,
      chatgptPlanType: "pro",
    });
  });

  it("redacts a device login's code and URL in the response", () => {
    const stored = redactCodexPayload("account/login/start", {
      result: {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      },
    });
    expect(stored).toEqual({
      result: {
        type: "chatgptDeviceCode",
        loginId: REDACTED,
        verificationUrl: REDACTED,
        userCode: REDACTED,
      },
    });
  });

  it("redacts the token refresh Codex asks for, both ways", () => {
    expect(
      redactCodexPayload("account/chatgptAuthTokens/refresh", {
        reason: "unauthorized",
        previousAccountId: "acct-1234",
      }),
    ).toEqual({ reason: "unauthorized", previousAccountId: REDACTED });
    expect(
      redactCodexPayload("account/chatgptAuthTokens/refresh", {
        result: { accessToken: JWT, chatgptAccountId: "acct-1234", chatgptPlanType: null },
      }),
    ).toEqual({
      result: { accessToken: REDACTED, chatgptAccountId: REDACTED, chatgptPlanType: null },
    });
  });

  it("redacts MCP servers' headers, env and URLs in thread/start, thread/fork and thread/resume", () => {
    const config = {
      mcp_servers: {
        github: {
          url: "https://mcp.example.com/s/abc123secretpath?key=xyz",
          http_headers: { Authorization: "Bearer ghp_abcdefghijklmnop", "X-Team": "core" },
          startup_timeout_sec: 20,
          tool_timeout_sec: 120,
        },
        notion: {
          command: "npx",
          args: ["-y", "@notionhq/notion-mcp-server"],
          env: { NOTION_TOKEN: "ntn_secret_value", LOG_LEVEL: "info" },
        },
      },
      "model_providers.open-bot-api": {
        name: "OpenAI API",
        base_url: "http://worker.railway.internal:4001/model-proxy/0f1e2d3c4b5a/api",
        wire_api: "responses",
        experimental_bearer_token: API_KEY,
      },
    };
    for (const method of ["thread/start", "thread/fork", "thread/resume"]) {
      const stored = redactCodexPayload(method, {
        threadId: "thr",
        cwd: "/home/bot/work",
        config,
      }) as { config: typeof config };
      const github = stored.config.mcp_servers.github;
      expect(github.url).toBe(`https://mcp.example.com/${REDACTED}`);
      expect(github.http_headers).toEqual({ Authorization: REDACTED, "X-Team": REDACTED });
      expect(github.startup_timeout_sec).toBe(20);
      expect(stored.config.mcp_servers.notion.env).toEqual({
        NOTION_TOKEN: REDACTED,
        LOG_LEVEL: REDACTED,
      });
      expect(stored.config.mcp_servers.notion.args).toEqual(config.mcp_servers.notion.args);
      const provider = stored.config["model_providers.open-bot-api"];
      expect(provider.experimental_bearer_token).toBe(REDACTED);
      expect(provider.base_url).toBe(
        `http://worker.railway.internal:4001/model-proxy/${REDACTED}/api`,
      );
      const all = strings(stored).join("\n");
      for (const secret of ["ghp_", "ntn_secret", "abc123secretpath", "key=xyz", API_KEY])
        expect(all).not.toContain(secret);
    }
  });

  it("redacts the dotted form of an MCP server override", () => {
    const stored = redactCodexPayload("thread/fork", {
      config: { "mcp_servers.github": { url: "https://mcp.example.com/" } },
    }) as { config: Record<string, { url: string }> };
    expect(stored.config["mcp_servers.github"]!.url).toBe("https://mcp.example.com");
  });

  it("redacts credentials by key at any depth, and keeps token counts", () => {
    const stored = redactCodexPayload("thread/tokenUsage/updated", {
      threadId: "thr",
      tokenUsage: { total: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 40 } },
      nested: [
        { api_key: API_KEY, password: "hunter2", cookie: "session=abc", secret: { a: "b" } },
      ],
    });
    expect(stored).toEqual({
      threadId: "thr",
      tokenUsage: { total: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 40 } },
      nested: [
        { api_key: REDACTED, password: REDACTED, cookie: REDACTED, secret: { a: REDACTED } },
      ],
    });
  });

  it("redacts JWTs, API keys and bearer credentials inside any string", () => {
    const stored = redactCodexPayload("item/completed", {
      threadId: "thr",
      item: {
        type: "commandExecution",
        id: "call_1",
        command: "cat backup.json",
        aggregatedOutput: `{"access_token":"${JWT}","key":"${API_KEY}"}\ncurl -H "Authorization: Bearer abcdefgh12345678"`,
        exitCode: 0,
      },
    }) as { item: { aggregatedOutput: string; exitCode: number } };
    expect(stored.item.aggregatedOutput).not.toContain(JWT);
    expect(stored.item.aggregatedOutput).not.toContain(API_KEY);
    expect(stored.item.aggregatedOutput).not.toContain("abcdefgh12345678");
    expect(stored.item.aggregatedOutput).toContain('curl -H "Authorization: [redacted]"');
    expect(stored.item.exitCode).toBe(0);
  });

  it("redacts an opaque refresh token serialized in a command's output", () => {
    // Opaque, so no pattern of its own matches it: only its key gives it away.
    const refresh = "rt_8Hq2LmNpQ4vX9zT1wY6kB3cF5gJ7";
    const output = JSON.stringify(
      { tokens: { refresh_token: refresh, account_id: "acct-1234" }, last_refresh: "2026-11-16" },
      null,
      2,
    );
    const stored = redactCodexPayload("item/completed", {
      threadId: "thr",
      item: {
        type: "commandExecution",
        id: "call_1",
        command: "cat backup.json",
        aggregatedOutput: output,
      },
    }) as { item: { aggregatedOutput: string } };
    expect(stored.item.aggregatedOutput).not.toContain(refresh);
    expect(stored.item.aggregatedOutput).not.toContain("acct-1234");
    expect(stored.item.aggregatedOutput).toContain(`"refresh_token": "${REDACTED}"`);
    expect(stored.item.aggregatedOutput).toContain('"last_refresh": "2026-11-16"');
    // Escaped inside another JSON string, as a tool's result often is.
    const nested = redactCodexPayload("item/completed", {
      text: JSON.stringify({ result: output }),
    }) as { text: string };
    expect(nested.text).not.toContain(refresh);
  });

  it("redacts credentials in a tool's serialized result", () => {
    const stored = redactCodexPayload("item/tool/call", {
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: '{"site":"shop.example","username":"ava","password":"hunter2-opaque"}',
          },
          {
            type: "inputText",
            text: "export OPENAI_API_KEY=opaque-key-123\nclient_secret: s3cr3t-yaml",
          },
          { type: "inputText", text: "GET /cb?code=x&access_token=opaqueTokenValue&state=1" },
          {
            type: "inputText",
            text: "Authorization: Basic dXNlcjpwYXNz\nCookie: session=abc; csrf=def",
          },
        ],
      },
    });
    const text = strings(stored).join("\n");
    for (const secret of [
      "hunter2-opaque",
      "opaque-key-123",
      "s3cr3t-yaml",
      "opaqueTokenValue",
      "dXNlcjpwYXNz",
      "session=abc",
      "csrf=def",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('"username":"ava"');
    expect(text).toContain("state=1");
  });

  it("redacts shell-quoted, URL, multiline .netrc and inline header credentials", () => {
    const stored = redactCodexPayload("item/completed", {
      item: {
        type: "commandExecution",
        id: "call_1",
        command: `bash -lc "export API_TOKEN=$'opaque-1' && curl -H 'Cookie: session=opaque-2; csrf=opaque-3' https://alice:opaque-4@example.test"`,
        aggregatedOutput: "machine example.test\n  login ava\n  password opaque-5\n",
      },
    });
    const text = strings(stored).join("\n");
    for (const secret of ["opaque-1", "opaque-2", "opaque-3", "opaque-4", "opaque-5", "alice"])
      expect(text).not.toContain(secret);
    expect(text).toContain("Cookie: [redacted]'");
    expect(text).toContain("https://[redacted]@example.test");
  });

  it("keeps only what a command or file change touching a credentials file is", () => {
    const command = redactCodexPayload("item/completed", {
      threadId: "thr",
      item: {
        type: "commandExecution",
        id: "call_1",
        command: "/bin/bash -lc 'cat ~/.codex/auth.json'",
        commandActions: [{ type: "read", name: "auth.json", path: "/home/bot/.codex/auth.json" }],
        aggregatedOutput: "opaque-session-material-without-a-key",
        exitCode: 0,
        status: "completed",
      },
    }) as { item: Record<string, unknown> };
    expect(command.item).toMatchObject({
      command: "[redacted: a command that reads or writes .codex/auth.json]",
      aggregatedOutput: CREDENTIAL_FILE_REDACTED,
      exitCode: 0,
      status: "completed",
    });
    for (const [path, content] of [
      ["/home/bot/.netrc", "machine api.example login ava password opaque1"],
      ["/home/bot/.aws/credentials", "aws_secret = opaque2"],
      ["/home/bot/project/.env", "STRIPE=opaque3"],
      ["/home/bot/.ssh/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----opaque4"],
    ]) {
      const change = redactCodexPayload("item/completed", {
        item: {
          type: "fileChange",
          id: "call_2",
          changes: [{ path, kind: { type: "add" }, diff: content }],
        },
      });
      expect(strings(change), path).toContain(path);
      expect(strings(change).join(" "), path).not.toContain("opaque");
    }
    // A command can hold what it writes, so it isn't kept either, here or in its parsed actions.
    const written = redactCodexPayload("item/started", {
      item: {
        type: "commandExecution",
        command: "printf 'machine example.test login ava password opaque5\\n' > .netrc",
        commandActions: [{ type: "unknown", command: "printf 'machine ... opaque5' > .netrc" }],
      },
    });
    expect(strings(written).join(" ")).not.toContain("opaque5");
    expect(strings(written)).toContain("[redacted: a command that reads or writes .netrc]");
    // A .netrc entry is redacted wherever it appears.
    expect(
      redactCodexPayload("item/completed", { text: "machine x.test login ava password opaque6" }),
    ).toEqual({ text: `machine x.test login ${REDACTED} password ${REDACTED}` });
    // A file that only looks similar is kept as it is.
    const notes = {
      item: {
        type: "commandExecution",
        command: "cat .envrc.md notes.txt",
        aggregatedOutput: "hello",
      },
    };
    expect(redactCodexPayload("item/completed", notes)).toEqual(notes);
  });

  it("refuses payloads too deep or too large to walk, and stops at a cycle", () => {
    let deep: unknown = "bottom";
    for (let index = 0; index < 12_000; index += 1) deep = { next: deep };
    expect(() => redactCodexPayload("item/completed", deep)).toThrow(UnstorablePayload);
    const wide = { items: Array.from({ length: MAX_EVENT_NODES }, (_, index) => index) };
    expect(() => redactCodexPayload("item/completed", wide)).toThrow(UnstorablePayload);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(redactCodexPayload("item/completed", cyclic)).toEqual({
      name: "loop",
      self: "[circular]",
    });
  });

  it("keeps a file's size instead of its bytes, and cuts very long strings", () => {
    expect(
      redactCodexPayload("fs/writeFile", { path: "/x", dataBase64: "aGVsbG8gd29ybGQ=" }),
    ).toEqual({ path: "/x", dataBase64: "[12 bytes]" });
    const long = "a".repeat(MAX_EVENT_STRING + 1000);
    const stored = redactCodexPayload("item/completed", { text: long }) as { text: string };
    expect(stored.text.length).toBeLessThan(long.length);
    expect(stored.text).toContain("[1000 more characters]");
  });

  it("leaves ordinary messages as they are", () => {
    const params = {
      threadId: "thr",
      turnId: "turn",
      item: { type: "agentMessage", id: "msg_1", text: "Done: wrote notes.md", phase: null },
    };
    expect(redactCodexPayload("item/completed", params)).toEqual(params);
  });
});
