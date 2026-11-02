import { RPCHandler } from "@orpc/server/fetch";
import { router } from "@/lib/server/api/router";
import { allowedOrigin } from "@/lib/server/origin";

export const dynamic = "force-dynamic";

const handler = new RPCHandler(router);

/**
 * The open-bot API (see `@open-bot/api`). The phone calls it with its session cookie; browsers
 * may only call it from the app's own pages.
 */
async function handle(request: Request): Promise<Response> {
  if (!allowedOrigin(request.headers.get("origin"), request.headers.get("host")))
    return Response.json({ error: "Requests from other sites aren't allowed." }, { status: 403 });
  const { response } = await handler.handle(request, {
    prefix: "/api/rpc",
    context: { headers: request.headers },
  });
  return response ?? new Response("Not found", { status: 404 });
}

export const GET = handle;
export const POST = handle;
