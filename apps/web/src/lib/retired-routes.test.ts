import { describe, expect, it } from "vitest";
import { isRetiredRead } from "./retired-routes";

const read = (path: string) => isRetiredRead(path.split("/"));

describe("reads only old tabs make", () => {
  it("knows the reads that became procedures", () => {
    expect(read("state")).toBe(true);
    expect(read("chats/5b3c1f8e-1d2a-4b6c-9e7f-0a1b2c3d4e5f")).toBe(true);
    expect(read("bots/abc/lessons")).toBe(true); // vocabulary: allow (an old URL)
    expect(read("pages/versions/abc/link")).toBe(true);
    expect(read("search/pages")).toBe(true);
  });

  it("leaves every other path a plain 404", () => {
    expect(read("statement")).toBe(false);
    expect(read("chats")).toBe(false);
    expect(read("chats/abc/extra")).toBe(false);
    expect(read("bots/abc/export/more")).toBe(false); // vocabulary: allow (an old URL)
    expect(read("pages/versions/abc/thumbnail/x")).toBe(false);
  });
});
