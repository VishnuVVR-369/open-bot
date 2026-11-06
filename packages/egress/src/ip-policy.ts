import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * Destinations the egress agent refuses, so a bot can never reach devices on your home network or
 * your carrier's.
 *
 * Written over raw address bytes (not Node's BlockList) so the phone's Kotlin agent can implement
 * exactly the same rules; `test-vectors/ip-policy.json` keeps the two in step.
 */

type Range = readonly [prefix: readonly number[], bits: number];

const BLOCKED_V4: readonly Range[] = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved and broadcast
];

const v6 = (...groups: number[]) => groups.flatMap((group) => [group >> 8, group & 0xff]);

const BLOCKED_V6: readonly Range[] = [
  [v6(0, 0, 0, 0, 0, 0), 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  [v6(0x64, 0xff9b, 1), 48], // local-use NAT64, which can translate to anything
  [v6(0x100, 0, 0, 0), 64], // discard-only
  [v6(0x2001, 0), 32], // Teredo, which tunnels to an address the policy can't see
  [v6(0x2001, 0xdb8), 32], // documentation
  [v6(0xfc00), 7], // unique local
  [v6(0xfe80), 10], // link-local
  [v6(0xfec0), 10], // site-local (deprecated, but still private where used)
  [v6(0xff00), 8], // multicast
];

/** IPv6 ranges that carry an IPv4 address, and where: the IPv4 rules decide those. */
const EMBEDDING_V6: readonly (readonly [Range, number])[] = [
  [[v6(0, 0, 0, 0, 0, 0xffff), 96], 12], // IPv4-mapped
  [[v6(0x64, 0xff9b, 0, 0, 0, 0), 96], 12], // NAT64 well-known prefix
  [[v6(0x2002), 16], 2], // 6to4
];

/** A network's own NAT64 prefix (RFC 6052), like `2001:db8:64::/96`. */
export interface Nat64Prefix {
  prefix: string;
  length: 32 | 40 | 48 | 56 | 64 | 96;
}

export interface AddressPolicyOptions {
  /** NAT64 prefixes of the network the agent connects from, if it knows them. */
  nat64?: readonly Nat64Prefix[];
}

function inRange(bytes: readonly number[], [prefix, bits]: Range): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const index = bit / 8;
    const width = Math.min(8, bits - bit);
    const mask = (0xff << (8 - width)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

/** The 4 bytes of an IPv4 literal, or null. */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** The 16 bytes of an IPv6 literal (with an optional embedded IPv4 tail), or null. */
export function parseIPv6(text: string): number[] | null {
  if (text.includes("%")) return null; // zone ids only make sense for local addresses
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".", lastColon)) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    // Two placeholder groups stand in for the dotted tail, so the group count works out.
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (halves.length === 2 && left.length + right.length > 7) return null;
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Where RFC 6052 puts the IPv4 address after a prefix of each length (bits 64-71 are skipped). */
const NAT64_LAYOUT: Record<Nat64Prefix["length"], readonly number[]> = {
  32: [4, 5, 6, 7],
  40: [5, 6, 7, 9],
  48: [6, 7, 9, 10],
  56: [7, 9, 10, 11],
  64: [9, 10, 11, 12],
  96: [12, 13, 14, 15],
};

function isPublicV4(bytes: readonly number[]): boolean {
  return !BLOCKED_V4.some((range) => inRange(bytes, range));
}

function isPublicV6(bytes: readonly number[], options: AddressPolicyOptions): boolean {
  for (const [range, offset] of EMBEDDING_V6)
    if (inRange(bytes, range)) return isPublicV4(bytes.slice(offset, offset + 4));
  for (const { prefix, length } of options.nat64 ?? []) {
    const prefixBytes = parseIPv6(prefix);
    if (!prefixBytes) continue;
    if (inRange(bytes, [prefixBytes, length]))
      return isPublicV4(NAT64_LAYOUT[length].map((index) => bytes[index]!));
  }
  return !BLOCKED_V6.some((range) => inRange(bytes, range));
}

/** Whether the agent may connect to this IP address. Anything that isn't an IP literal is refused. */
export function isPublicAddress(address: string, options: AddressPolicyOptions = {}): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPublicV4(v4);
  const v6bytes = parseIPv6(address);
  if (v6bytes) return isPublicV6(v6bytes, options);
  return false;
}

export class BlockedDestinationError extends Error {
  constructor(host: string) {
    super(`Refused to connect to ${host}: private and local addresses are blocked`);
    this.name = "BlockedDestinationError";
  }
}

/** Removes the brackets of an IPv6 literal written as a URL host. */
export function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

/**
 * Resolve a host and return a public address to connect to.
 * Connecting to the resolved address (instead of the name) prevents DNS rebinding between check and use.
 */
export async function resolvePublicAddress(
  host: string,
  resolve: Resolver = (h) => lookup(h, { all: true }),
  options: AddressPolicyOptions = {},
): Promise<string> {
  const literal = unbracket(host);
  if (isIP(literal) || parseIPv4(literal) || parseIPv6(literal)) {
    if (!isPublicAddress(literal, options)) throw new BlockedDestinationError(host);
    return literal;
  }
  const addresses = await resolve(literal);
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  // Refuse the whole name if any of its addresses is private, so a name can't mix both.
  if (addresses.some((entry) => !isPublicAddress(entry.address, options))) {
    throw new BlockedDestinationError(host);
  }
  const preferred = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return preferred!.address;
}
