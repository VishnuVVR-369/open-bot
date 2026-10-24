import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * Destinations the egress agent refuses, so a bot can never reach devices on your home network.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) follow the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return !blocked.check(mapped[1], "ipv4");
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

export class BlockedDestinationError extends Error {
  constructor(host: string) {
    super(`Refused to connect to ${host}: private and local addresses are blocked`);
    this.name = "BlockedDestinationError";
  }
}

/**
 * Resolve a host and return a public address to connect to.
 * Connecting to the resolved address (instead of the name) prevents DNS rebinding between check and use.
 */
export async function resolvePublicAddress(
  host: string,
  resolve: (host: string) => Promise<{ address: string; family: number }[]> = (h) =>
    lookup(h, { all: true }),
): Promise<string> {
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(literal)) {
    if (!isPublicAddress(literal)) throw new BlockedDestinationError(host);
    return literal;
  }
  const addresses = await resolve(literal);
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  // Refuse the whole name if any of its addresses is private, so a name can't mix both.
  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new BlockedDestinationError(host);
  }
  const preferred = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return preferred!.address;
}
