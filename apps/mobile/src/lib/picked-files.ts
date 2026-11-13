import type { PickedFile } from "./uploads";

/** The most files one message can carry. */
export const MAX_ATTACHMENTS = 20;

/** Where you attach from: a new photo, your photos, or your files. */
export type AttachSource = "camera" | "photos" | "files";

/** A file from the document picker, which may not know its type or size. */
export function pickedDocument(asset: {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}): PickedFile {
  return {
    uri: asset.uri,
    name: asset.name,
    mime: asset.mimeType ?? "application/octet-stream",
    size: asset.size ?? 0,
  };
}

/**
 * A photo from the camera or your photos. One without a file name gets "photo-" or "image-", the
 * time, its place among the photos picked together after the first, and an extension from its
 * type (JPEG is ".jpg").
 */
export function pickedPhoto(
  asset: { uri: string; fileName?: string | null; mimeType?: string; fileSize?: number },
  { source, index, now }: { source: "camera" | "photos"; index: number; now: number },
): PickedFile {
  const extension = asset.mimeType?.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  return {
    uri: asset.uri,
    name:
      asset.fileName ??
      `${source === "camera" ? "photo" : "image"}-${now}${index ? `-${index}` : ""}.${extension}`,
    mime: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? 0,
  };
}
