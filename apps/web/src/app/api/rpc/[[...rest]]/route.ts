import { RPCHandler } from "@orpc/server/fetch";
import { router } from "@/lib/server/api/router";
import { crossSiteRefusal } from "@/lib/server/origin";

export const dynamic = "force-dynamic";

/**
 * oRPC's strict GET check stays on (its default): only a procedure whose route says GET answers a
 * GET, and none does, so a link or image on another site, which sends your cookies without an
 * `Origin`, can never reach a write.
 */
const handler = new RPCHandler(router, { strictGetMethodPluginEnabled: true });

/**
 * The open-bot API (see `@open-bot/api`). The phone calls it with its session cookie; browsers
 * may only call it from the app's own pages.
 */
async function handle(request: Request): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const { response } = await handler.handle(request, {
    prefix: "/api/rpc",
    context: { headers: request.headers },
  });
  return response ?? new Response("Not found", { status: 404 });
}

export const GET = handle;
export const POST = handle;
