// The proxy's copy of a response: decompressed when the upstream compressed it, and rebuilt as it
// streams by, under one limit on what it holds. The response itself never waits on it.
import type { IncomingHttpHeaders } from "node:http";
import type { Transform } from "node:stream";
import { finished as streamFinished } from "node:stream/promises";
import zlib from "node:zlib";
import { RESPONSE_TOO_LARGE, ResponseReader, headerValue, unreadable } from "@open-bot/domain";

/** How much of a response is kept as it came, for one that can't be rebuilt. */
export const RAW_RESPONSE_LIMIT = 1024 * 1024;
/**
 * What reading one response may hold, counted in bytes of compressed input not yet decompressed
 * and characters of text: an unfinished event, the items rebuilt so far, and what was noted along
 * the way. It is checked after every chunk, going in and coming out of the decompressor, so it is
 * passed by one chunk at most. Past it the response is still forwarded whole, and only its log
 * gives up on the body. The raw start of the response (`RAW_RESPONSE_LIMIT`) is kept besides.
 */
export const CAPTURE_LIMIT = 16 * 1024 * 1024;

/** Decompressors for the logged copy of a response, by `content-encoding`. */
const DECOMPRESSORS: Record<string, () => Transform> = {
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
  zstd: () => zlib.createZstdDecompress(),
};

/**
 * The logged copy of a response: decompressed when the upstream compressed it, rebuilt event by
 * event, with its start kept as it came in case it can't be rebuilt. What it holds stays under
 * one limit; past it the copy is abandoned and the log says so.
 */
export class ResponseTap {
  private readonly reader: ResponseReader;
  private decoder: Transform | null = null;
  private readonly warnings: string[] = [];
  private raw: Buffer[] = [];
  private rawBytes = 0;
  private rawCut = false;
  private readable = true;

  constructor(
    headers: IncomingHttpHeaders,
    private readonly limit: number,
  ) {
    this.reader = new ResponseReader(headerValue(headers, "content-type") ?? null, limit);
    const coding = (headerValue(headers, "content-encoding") ?? "").trim().toLowerCase();
    if (!coding || coding === "identity") return;
    const make = DECOMPRESSORS[coding];
    if (!make) {
      this.readable = false;
      this.warnings.push("the response used an encoding the proxy can't read");
      return;
    }
    this.decoder = make();
    this.decoder.on("data", (chunk: Buffer) => this.read(chunk));
    // A stream cut short doesn't decompress to the end; what came before it is still read.
    this.decoder.on("error", () => this.warnings.push("the response could not be decompressed"));
  }

  /** What it holds now, against its limit: compressed input waiting, and what the reader holds. */
  get held(): number {
    return (this.decoder?.writableLength ?? 0) + this.reader.held;
  }

  /** Reads a chunk the response forwarded. It never throws: a failure costs only the copy. */
  write(chunk: Buffer): void {
    if (!this.readable || this.reader.abandoned) return;
    if (!this.decoder) return this.read(chunk);
    // Compressed input waiting for the decompressor counts too: it can fall behind the network.
    if (this.held + chunk.length > this.limit) return this.abandon();
    try {
      this.decoder.write(chunk);
    } catch (error) {
      this.abandon(unreadable(error));
    }
  }

  async end(): Promise<{
    response: ReturnType<ResponseReader["end"]> | null;
    raw: string | null;
    warnings: string[];
  }> {
    if (this.decoder) {
      this.decoder.end();
      await streamFinished(this.decoder).catch(() => undefined);
    }
    const raw = this.raw.length ? Buffer.concat(this.raw).toString("utf8") : null;
    this.raw = [];
    const response = this.readable ? this.reader.end() : null;
    if (raw !== null && this.rawCut && (!response || !response.parsed || !response.complete))
      this.warnings.push(`only the first ${this.rawBytes} bytes of the response were kept`);
    return { response, raw, warnings: this.warnings };
  }

  /** Reads a chunk, from the response or the decompressor; it never throws out of their events. */
  private read(chunk: Buffer) {
    if (this.reader.abandoned) return;
    try {
      this.keepRaw(chunk);
      this.reader.push(chunk);
    } catch (error) {
      return this.abandon(unreadable(error));
    }
    // Decompressed output grows what the reader holds while compressed input may still wait.
    if (this.reader.abandoned || this.held > this.limit) this.abandon();
  }

  private keepRaw(chunk: Buffer) {
    if (this.rawBytes >= RAW_RESPONSE_LIMIT) {
      this.rawCut ||= chunk.length > 0;
      return;
    }
    const kept = chunk.subarray(0, RAW_RESPONSE_LIMIT - this.rawBytes);
    this.rawCut ||= kept.length < chunk.length;
    this.raw.push(kept);
    this.rawBytes += kept.length;
  }

  /** Gives up on the copy; the response itself is still forwarded whole. */
  private abandon(reason = RESPONSE_TOO_LARGE) {
    this.reader.abandon(reason);
    // Nothing more is kept as it came either.
    this.rawCut = this.rawBytes > 0;
    if (this.decoder) {
      this.decoder.removeAllListeners("data");
      this.decoder.destroy();
      this.decoder = null;
    }
  }
}
