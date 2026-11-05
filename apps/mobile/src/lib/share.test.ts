import { describe, expect, it } from "vitest";
import { parseShared, shareMessage } from "./share";

describe("what was shared", () => {
  it("finds the link in a post shared from another app", () => {
    const item = parseShared({
      text: "Check out this post about how Discord stores trillions of messages https://www.linkedin.com/posts/abc-123?utm=x.",
      subject: null,
    });
    expect(item).toEqual({
      url: "https://www.linkedin.com/posts/abc-123?utm=x",
      text: "Check out this post about how Discord stores trillions of messages",
      full: "Check out this post about how Discord stores trillions of messages https://www.linkedin.com/posts/abc-123?utm=x.",
    });
  });

  it("uses the subject when the text is only a link", () => {
    const item = parseShared({ text: "https://example.com/a", subject: "How Kafka works" });
    expect(item?.url).toBe("https://example.com/a");
    expect(item?.text).toBe("How Kafka works");
    expect(item?.full).toBe("How Kafka works\nhttps://example.com/a");
  });

  it("doesn't repeat a subject that's already in the text", () => {
    const item = parseShared({
      text: "How Kafka works https://example.com",
      subject: "How Kafka works",
    });
    expect(item?.full).toBe("How Kafka works https://example.com");
  });

  it("keeps plain text without a link", () => {
    expect(parseShared({ text: "  some notes\r\nmore  ", subject: null })).toEqual({
      url: null,
      text: "some notes\nmore",
      full: "some notes\nmore",
    });
  });

  it("ignores an empty share", () => {
    expect(parseShared({ text: "  ", subject: " " })).toBeNull();
  });
});

describe("the message a share becomes", () => {
  const item = parseShared({ text: "Read this https://example.com/post", subject: null })!;

  it("asks for a page with the /page skill", () => {
    expect(shareMessage("page", item, "")).toBe(
      "/page Research this and make a page that explains it in depth.\n\nRead this https://example.com/post",
    );
    expect(shareMessage("page", item, " Focus on the storage layer ")).toBe(
      "/page Research this and make a page that explains it in depth.\nFocus on the storage layer\n\nRead this https://example.com/post",
    );
  });

  it("asks for a summary", () => {
    expect(shareMessage("summary", item, "")).toMatch(/^Read this and give me a short summary/);
  });

  it("sends it as it is, after your note", () => {
    expect(shareMessage("send", item, "")).toBe("Read this https://example.com/post");
    expect(shareMessage("send", item, "fyi")).toBe("fyi\n\nRead this https://example.com/post");
  });
});
