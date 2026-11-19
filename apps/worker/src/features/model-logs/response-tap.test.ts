import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { ResponseTap } from "./response-tap";
import { sseEvent } from "./testing";

const LIMIT = 64 * 1024;
const delta = (text: string) => sseEvent({ type: "response.output_text.delta", delta: text });

/** Writes a body to a tap in pieces, all before the decompressor gets to run. */
function writeAll(tap: ResponseTap, body: Buffer, size = 4096) {
  for (let at = 0; at < body.length; at += size) tap.write(body.subarray(at, at + size));
}

describe("ResponseTap", () => {
  it("rebuilds a compressed stream that stays within its limit", async () => {
    const tap = new ResponseTap(
      { "content-type": "text/event-stream", "content-encoding": "gzip" },
      LIMIT,
    );
    writeAll(tap, zlib.gzipSync(delta("x".repeat(LIMIT / 4)).repeat(8)));
    const { response } = await tap.end();
    expect(response?.warnings).toEqual(["the stream ended before the response did"]);
  });

  it("counts what decompressing adds while compressed input still waits", async () => {
    const tap = new ResponseTap(
      { "content-type": "text/event-stream", "content-encoding": "gzip" },
      LIMIT,
    );
    // Two gzip members: one event inflating to 90% of the limit, then events stored as they are,
    // half the limit of input still waiting while the first one is read. Neither alone passes it.
    const big = zlib.gzipSync(delta("x".repeat(Math.floor(LIMIT * 0.9))), { level: 9 });
    const waiting = zlib.gzipSync(delta("y".repeat(1000)).repeat(Math.ceil(LIMIT / 2 / 1000)), {
      level: 0,
    });
    expect(big.length).toBeLessThan(1024);
    writeAll(tap, Buffer.concat([big, waiting]));
    expect(tap.held).toBeGreaterThan(LIMIT / 2);
    const { response } = await tap.end();
    expect(response?.warnings).toContain("the response was too large to read");
  });
});
