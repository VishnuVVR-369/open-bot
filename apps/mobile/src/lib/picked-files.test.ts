import { describe, expect, it } from "vitest";
import { pickedDocument, pickedPhoto } from "./picked-files";

describe("picked files", () => {
  it("takes a document as it is, with a generic type and no size when the picker has none", () => {
    expect(
      pickedDocument({ uri: "file://a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 9 }),
    ).toEqual({
      uri: "file://a.pdf",
      name: "a.pdf",
      mime: "application/pdf",
      size: 9,
    });
    expect(pickedDocument({ uri: "file://b", name: "b" })).toEqual({
      uri: "file://b",
      name: "b",
      mime: "application/octet-stream",
      size: 0,
    });
  });

  it("keeps a photo's own file name", () => {
    expect(
      pickedPhoto(
        { uri: "file://p", fileName: "IMG_1.heic", mimeType: "image/heic", fileSize: 5 },
        { source: "photos", index: 3, now: 1 },
      ),
    ).toEqual({ uri: "file://p", name: "IMG_1.heic", mime: "image/heic", size: 5 });
  });

  it("names a photo without one by where it came from, when, and its place after the first", () => {
    const now = 1_700_000_000_000;
    expect(
      pickedPhoto({ uri: "file://c", mimeType: "image/jpeg" }, { source: "camera", index: 0, now }),
    ).toEqual({
      uri: "file://c",
      name: `photo-${now}.jpg`,
      mime: "image/jpeg",
      size: 0,
    });
    expect(
      pickedPhoto(
        { uri: "file://d", fileName: null, mimeType: "image/png" },
        { source: "photos", index: 2, now },
      ).name,
    ).toBe(`image-${now}-2.png`);
    // No type at all: a JPEG.
    expect(pickedPhoto({ uri: "file://e" }, { source: "photos", index: 0, now })).toMatchObject({
      name: `image-${now}.jpg`,
      mime: "image/jpeg",
    });
  });
});
