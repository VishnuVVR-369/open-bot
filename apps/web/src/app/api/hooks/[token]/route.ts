import { NextResponse } from "next/server";
import { worker, WorkerError } from "@/lib/server/worker";

/** The most a webhook request can carry. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * A teammate's webhook. Public: the secret token in the URL is the credential, so anything that
 * knows the URL can start the teammate (up to a limit an hour).
 */
async function receive(
  request: Request,
  { params }: RouteContext<"/api/hooks/[token]">,
): Promise<Response> {
  const { token } = await params;
  if (!/^[\w-]{20,64}$/.test(token))
    return NextResponse.json({ error: "Unknown webhook" }, { status: 404 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    return NextResponse.json({ error: "The request body is too large." }, { status: 413 });
  const body = request.method === "GET" ? "" : await request.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    return NextResponse.json({ error: "The request body is too large." }, { status: 413 });
  try {
    const result = await worker<{ runId: string }>(
      "POST",
      `/internal/hooks/${encodeURIComponent(token)}`,
      {
        method: request.method,
        contentType: request.headers.get("content-type") ?? "",
        body,
        query: new URL(request.url).search.replace(/^\?/, ""),
      },
    );
    return NextResponse.json({ ok: true, runId: result.runId }, { status: 202 });
  } catch (error) {
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status },
    );
  }
}

export const GET = receive;
export const POST = receive;
export const PUT = receive;
