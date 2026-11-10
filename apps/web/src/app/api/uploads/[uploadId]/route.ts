import { UPLOAD_HEADERS } from "@open-bot/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { putUpload } from "@/lib/server/api/uploads";
import { authed } from "@/lib/server/route";

export const dynamic = "force-dynamic";

const meta = z.object({
  uploadId: z.string().uuid("That upload id isn't valid."),
  name: z.string().trim().min(1, "The file needs a name.").max(255),
  mime: z.string().max(255),
  size: z.coerce.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "The file's SHA-256 is missing or malformed."),
});

function decoded(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/**
 * Upload an attachment as the raw request body (see `UPLOAD_HEADERS` in `@open-bot/api`). The
 * phone uploads straight from a file; a retry with the same id writes the same file again, and
 * once it's complete, returns it without writing.
 */
export const PUT = authed(
  async (request: Request, { params }: { params: Promise<{ uploadId: string }> }) => {
    const parsed = meta.safeParse({
      uploadId: (await params).uploadId,
      name: decoded(request.headers.get(UPLOAD_HEADERS.name)),
      mime: decoded(request.headers.get(UPLOAD_HEADERS.mime)) || "application/octet-stream",
      size: request.headers.get(UPLOAD_HEADERS.size) ?? "",
      sha256: (request.headers.get(UPLOAD_HEADERS.sha256) ?? "").toLowerCase(),
    });
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues.map((issue) => issue.message).join(". ") },
        { status: 400 },
      );
    if (!request.body) return NextResponse.json({ error: "No file was sent." }, { status: 400 });
    const { uploadId, ...file } = parsed.data;
    return NextResponse.json(await putUpload(uploadId, file, request.body));
  },
);
