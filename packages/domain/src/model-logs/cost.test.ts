import { describe, expect, it } from "vitest";
import { costMicros } from "../models";
import { estimateUsage, inputSizeOf, outputBytesOf, USAGE_ESTIMATE } from "./cost";

const image = `data:image/png;base64,${"A".repeat(400_000)}`;

describe("an API key request's usage estimate", () => {
  it("counts the input at 2 bytes a token, uncached, and each image as an image", () => {
    const body = {
      model: "gpt-5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "x".repeat(10_000) }] },
        { role: "user", content: [{ type: "input_image", image_url: image }] },
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.com/a.png" }],
        },
      ],
    };
    const size = inputSizeOf(body, false)!;
    expect(size.images).toBe(2);
    // The text and the JSON around it, never the image's 400,000 base64 bytes.
    expect(size.bytes).toBeGreaterThan(10_000);
    expect(size.bytes).toBeLessThan(11_000);
    const usage = estimateUsage({ input: size, outputBytes: 0, elapsedMs: 0 });
    expect(usage.inputTokens).toBe(Math.ceil(size.bytes / 2) + 2 * USAGE_ESTIMATE.imageTokens);
    expect(usage.cachedInputTokens).toBe(0);
  });

  it("counts UTF-8 bytes, so text in any script errs high", () => {
    // 1,000 Japanese characters are 3,000 bytes: 1,500 tokens counted, about 1,200 billed.
    const size = inputSizeOf({ input: "あ".repeat(1_000) }, false)!;
    expect(size.bytes).toBe(3_000 + '{"input":""}'.length);
  });

  it("counts the output as if the model wrote all along, or what streamed if more", () => {
    const at = (elapsedMs: number, outputBytes = 0) =>
      estimateUsage({ input: { bytes: 0, images: 0 }, outputBytes, elapsedMs }).outputTokens;
    expect(at(4_000)).toBe(1_000);
    expect(at(1_000, 10_000)).toBe(5_000);
    // A request left hanging counts at most the largest output.
    expect(at(3_600_000)).toBe(USAGE_ESTIMATE.maxOutputTokens);
  });

  it("counts the largest input when it can't be measured", () => {
    // Continued from a response the proxy didn't see: that response's context is billed too.
    expect(inputSizeOf({ previous_response_id: "resp_1", input: [] }, false)).toBeNull();
    expect(inputSizeOf({ previous_response_id: "resp_1", input: [] }, true)).not.toBeNull();
    expect(estimateUsage({ input: null, outputBytes: 0, elapsedMs: 0 }).inputTokens).toBe(
      USAGE_ESTIMATE.maxInputTokens,
    );
  });

  it("measures what streamed back by its text, its output items, or its pieces", () => {
    expect(outputBytesOf(null)).toBe(0);
    expect(outputBytesOf({ text: "hello", output: [], deltaBytes: 0 })).toBe(5);
    expect(
      outputBytesOf({
        text: "",
        output: [{ type: "function_call", arguments: "{}" }],
        deltaBytes: 0,
      }),
    ).toBe(JSON.stringify([{ type: "function_call", arguments: "{}" }]).length);
    // Cut off before any item was done: only the pieces streamed so far.
    expect(outputBytesOf({ text: "", output: [], deltaBytes: 9_000 })).toBe(9_000);
  });

  it("prices as the API key does, so an estimate is never free", () => {
    const usage = estimateUsage({
      input: { bytes: 20_000, images: 0 },
      outputBytes: 0,
      elapsedMs: 0,
    });
    expect(costMicros(usage)).toBe(10_000 * 2);
  });
});
