/** A service teammates use through MCP, with its secrets decrypted, as Codex needs it. */
export interface ConnectionConfig {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  headers: Record<string, string>;
  env: Record<string, string>;
}

/** "github" from "GitHub", "my_api" from "My API!": the name Codex knows a server by. */
export function connectionName(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "service"
  );
}

/** Why an MCP endpoint can't be used, or null when it can. */
export function invalidMcpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return "Use an http or https address.";
    return null;
  } catch {
    return "That isn't a web address.";
  }
}

/** Codex's `mcp_servers` config for these connections. */
export function mcpServersConfig(
  connections: ConnectionConfig[],
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const connection of connections) {
    servers[connection.name] =
      connection.transport === "http"
        ? {
            url: connection.url,
            ...(Object.keys(connection.headers).length ? { http_headers: connection.headers } : {}),
            startup_timeout_sec: 20,
            tool_timeout_sec: 120,
          }
        : {
            command: connection.command,
            args: connection.args,
            ...(Object.keys(connection.env).length ? { env: connection.env } : {}),
            startup_timeout_sec: 60,
            tool_timeout_sec: 120,
          };
  }
  return servers;
}

/** "Authorization: Bearer x" lines, as a header map. */
export function parseHeaderLines(text: string): Record<string, string> | string {
  const headers: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return `"${line.slice(0, 40)}" isn't a header. Write it as Name: value.`;
    const name = line.slice(0, colon).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) return `"${name}" isn't a header name.`;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** "API_KEY=x" lines, as environment variables. */
export function parseEnvLines(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return `"${line.slice(0, 40)}" isn't a variable. Write it as NAME=value.`;
    const name = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" isn't a variable name.`;
    env[name] = line.slice(equals + 1).trim();
  }
  return env;
}
