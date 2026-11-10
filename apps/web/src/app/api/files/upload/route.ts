import { UPLOAD_HEADERS } from "@open-bot/api";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/domain";
import { NextResponse } from "next/server";
import { authed } from "@/lib/server/route";
import { worker } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

const tooBig = () =>
  NextResponse.json({ error: `Files can be up to ${MAX_UPLOAD_LABEL}.` }, { status: 413 });

/** The body, or null once it's bigger than an upload may be, without reading the rest. */
async function readCapped(body: ReadableStream<Uint8Array>): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/**
 * Put a file into a folder on the computer (`?dir=`), as the raw request body, with its name in
 * the `x-upload-name` header (URI-encoded). A taken name gets a number; the answer has the path.
 */
export const PUT = authed(async (request: Request) => {
  const dir = new URL(request.url).searchParams.get("dir") ?? "";
  let name = "";
  try {
    name = decodeURIComponent(request.headers.get(UPLOAD_HEADERS.name) ?? "").trim();
  } catch {
    // Not URI-encoded: refused below.
  }
  if (!dir || !name)
    return NextResponse.json({ error: "Say which folder and file name." }, { status: 400 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) return tooBig();
  if (!request.body) return NextResponse.json({ error: "No file was sent." }, { status: 400 });
  const data = await readCapped(request.body);
  if (!data) return tooBig();
  const { path } = await worker.files.put(
    { dir, name, dataBase64: data.toString("base64") },
    { context: { timeoutMs: 120_000 } },
  );
  return NextResponse.json({ path });
});
