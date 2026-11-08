import { describe, expect, it } from "vitest";
import {
  connectionName,
  invalidMcpUrl,
  mcpServersConfig,
  parseEnvLines,
  parseHeaderLines,
} from "./connections";

describe("connectionName", () => {
  it("makes a name Codex accepts", () => {
    expect(connectionName("GitHub")).toBe("github");
    expect(connectionName("My company API!")).toBe("my_company_api");
    expect(connectionName("  ")).toBe("service");
  });
});

describe("invalidMcpUrl", () => {
  it("takes web addresses only", () => {
    expect(invalidMcpUrl("https://mcp.example.com/mcp")).toBeNull();
    expect(invalidMcpUrl("ftp://example.com")).toMatch(/http/);
    expect(invalidMcpUrl("example")).toMatch(/web address/);
  });
});

describe("parsing secrets", () => {
  it("reads headers and variables", () => {
    expect(parseHeaderLines("Authorization: Bearer abc\n\nX-Team: core")).toEqual({
      Authorization: "Bearer abc",
      "X-Team": "core",
    });
    expect(parseEnvLines("API_KEY=a=b\nREGION=eu")).toEqual({ API_KEY: "a=b", REGION: "eu" });
  });

  it("explains what's wrong", () => {
    expect(parseHeaderLines("Bearer abc")).toMatch(/isn't a header/);
    expect(parseEnvLines("1KEY=x")).toMatch(/isn't a variable name/);
  });
});

describe("mcpServersConfig", () => {
  it("configures http and command servers", () => {
    expect(
      mcpServersConfig([
        {
          name: "github",
          transport: "http",
          url: "https://api.example.com/mcp",
          command: null,
          args: [],
          headers: { Authorization: "Bearer x" },
          env: {},
        },
        {
          name: "files",
          transport: "stdio",
          url: null,
          command: "npx",
          args: ["-y", "server"],
          headers: {},
          env: {},
        },
      ]),
    ).toEqual({
      github: {
        url: "https://api.example.com/mcp",
        http_headers: { Authorization: "Bearer x" },
        startup_timeout_sec: 20,
        tool_timeout_sec: 120,
      },
      files: {
        command: "npx",
        args: ["-y", "server"],
        startup_timeout_sec: 60,
        tool_timeout_sec: 120,
      },
    });
  });
});
