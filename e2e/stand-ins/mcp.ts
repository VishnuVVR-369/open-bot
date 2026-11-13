import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** A small MCP server for an orders service, reachable from the computer, that records its calls. */
export async function ordersService() {
  const seen = { authorization: [] as string[], calls: [] as string[] };
  const server = http.createServer(async (request, response) => {
    seen.authorization.push(request.headers.authorization ?? "");
    const mcp = new McpServer({ name: "orders", version: "1.0.0" });
    mcp.registerTool(
      "lookup_order",
      {
        description: "Look up an order by its number: where it is and when it arrives.",
        inputSchema: { number: z.string() },
      },
      async ({ number }) => {
        seen.calls.push(number);
        return {
          content: [
            {
              type: "text",
              text: `Order ${number}: shipped on 12 October by Parcelo, arriving Friday.`,
            },
          ],
        };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => void transport.close());
    await mcp.connect(transport);
    let body = "";
    for await (const chunk of request) body += chunk;
    await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  return {
    seen,
    url: `http://host.docker.internal:${(server.address() as AddressInfo).port}/mcp`,
    // Codex keeps its connections open, which would hold close() up.
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
