import { describe, expect, it } from "vitest";
import { sendAttempt } from "./send";

describe("sendAttempt", () => {
  let next = 0;
  const newId = () => `id-${(next += 1)}`;

  it("reuses a failed attempt's id for the same message only", () => {
    const first = sendAttempt(null, ["chat", "hi", []], newId);
    expect(sendAttempt(first, ["chat", "hi", []], newId).clientId).toBe(first.clientId);
    expect(sendAttempt(first, ["chat", "hi!", []], newId).clientId).not.toBe(first.clientId);
    expect(sendAttempt(null, ["chat", "hi", []], newId).clientId).not.toBe(first.clientId);
  });
});
