import { NextResponse } from "next/server";
import { worker, WorkerError } from "@/lib/server/worker";

/** Emails with attachments can be large; Postmark's own limit is 35 MB. */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

/**
 * Where Postmark delivers emails to your teammates. Public: the secret token in the address is the
 * credential. Anything not for a teammate is accepted and dropped, so the sender doesn't retry it.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/inbound/email/[token]">,
): Promise<Response> {
  const { token } = await params;
  if (!/^[\w-]{20,64}$/.test(token))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    return NextResponse.json({ error: "The email is too large." }, { status: 413 });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Send the email as JSON." }, { status: 400 });
  }
  try {
    const result = await worker<{ botId: string | null }>(
      "POST",
      `/internal/email/inbound/${encodeURIComponent(token)}`,
      payload,
      60_000,
    );
    return NextResponse.json({ ok: true, delivered: result.botId !== null });
  } catch (error) {
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json(
      { error: status === 404 ? "Not found" : "Something went wrong" },
      { status },
    );
  }
}
