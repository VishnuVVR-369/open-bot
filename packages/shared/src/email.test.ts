import { describe, expect, it } from "vitest";
import { htmlToText, parseInboundEmail, recipientHandle, replySubject } from "./email";

const postmark = {
  From: "Dana Smith <dana@example.com>",
  FromFull: { Email: "Dana@Example.com", Name: "Dana Smith" },
  To: "iris@team.example.com",
  ToFull: [{ Email: "iris+travel@team.example.com", Name: "" }],
  Subject: "Flights for May",
  TextBody: "Can you find flights?",
  HtmlBody: "<p>Can you find <b>flights</b>?</p>",
  MessageID: "abc-123",
  Headers: [{ Name: "In-Reply-To", Value: "<earlier@team.example.com>" }],
  Attachments: [{ Name: "itinerary.pdf", ContentType: "application/pdf", Content: "JVBERi0=" }],
};

describe("parseInboundEmail", () => {
  it("reads Postmark's inbound JSON", () => {
    expect(parseInboundEmail(postmark)).toEqual({
      from: { email: "dana@example.com", name: "Dana Smith" },
      to: ["iris+travel@team.example.com"],
      cc: [],
      subject: "Flights for May",
      text: "Can you find flights?",
      messageId: "<abc-123>",
      inReplyTo: "<earlier@team.example.com>",
      attachments: [{ name: "itinerary.pdf", contentType: "application/pdf", base64: "JVBERi0=" }],
    });
  });

  it("falls back to the HTML part", () => {
    expect(parseInboundEmail({ ...postmark, TextBody: "" })?.text).toBe("Can you find flights?");
  });

  it("refuses what isn't an email", () => {
    expect(parseInboundEmail({ hello: "world" })).toBeNull();
    expect(parseInboundEmail(null)).toBeNull();
  });
});

describe("addresses", () => {
  it("finds the teammate, ignoring tags", () => {
    expect(recipientHandle("iris+travel@team.example.com", "team.example.com")).toBe("iris");
    expect(recipientHandle("iris@other.com", "team.example.com")).toBeNull();
  });

  it("makes reply subjects", () => {
    expect(replySubject("Flights")).toBe("Re: Flights");
    expect(replySubject("RE: Flights")).toBe("RE: Flights");
  });

  it("turns HTML into text", () => {
    expect(htmlToText("<style>p{}</style><p>Hi&nbsp;there</p><p>Bye</p>")).toBe("Hi there\nBye");
  });
});
