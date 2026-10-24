import { fileKind } from "@/lib/files";
import { authed } from "@/lib/server/route";
import { worker } from "@/lib/server/worker";

const TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  pdf: "application/pdf",
};

/** Text files, including HTML and SVG, are served as plain text so they never run in the app. */
function contentType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (TYPES[extension]) return TYPES[extension];
  return fileKind(name) === "text" ? "text/plain; charset=utf-8" : "application/octet-stream";
}

export const GET = authed(async (request: Request) => {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  const inline = url.searchParams.get("inline") === "1";
  const { dataBase64 } = await worker<{ dataBase64: string }>(
    "GET",
    `/internal/files/read?path=${encodeURIComponent(path)}`,
  );
  const name = path.split("/").pop() ?? "file";
  return new Response(Buffer.from(dataBase64, "base64"), {
    headers: {
      "content-type": contentType(name),
      // The plain name for old browsers, and the exact one (any language) for the rest.
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
    },
  });
});
