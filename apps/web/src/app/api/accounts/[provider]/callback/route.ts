import { isAccountProvider } from "@open-bot/shared";
import { NextResponse } from "next/server";
import { completeAuthorization } from "@/lib/server/accounts";
import { BASE_URL } from "@/lib/server/auth-config";
import { sessionOrNull } from "@/lib/server/session";

/**
 * Where a provider (Google, Notion, …) sends you back after you sign in. The state must be one this session
 * started in the last 10 minutes, and it's used once.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/accounts/[provider]/callback">,
): Promise<Response> {
  const { provider } = await params;
  const back = new URL("/settings", BASE_URL);
  back.hash = "connections";
  if (!isAccountProvider(provider)) {
    back.searchParams.set("account_error", "Unknown provider.");
    return NextResponse.redirect(back);
  }
  const session = await sessionOrNull();
  if (!session) return NextResponse.redirect(new URL("/login", BASE_URL));
  const query = new URL(request.url).searchParams;
  const outcome = await completeAuthorization({
    provider,
    sessionId: session.session.id,
    state: query.get("state"),
    code: query.get("code"),
    error: query.get("error"),
  });
  if (outcome.error) back.searchParams.set("account_error", outcome.error);
  if (outcome.connectionId) back.searchParams.set("connected", outcome.connectionId);
  if (outcome.missing.length) back.searchParams.set("missing", outcome.missing.join(","));
  return NextResponse.redirect(back);
}
