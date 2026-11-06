package dev.openbot.egress.core

/**
 * A network's own NAT64 prefix (RFC 6052), like `2001:db8:64::/96`. On Android it comes from
 * `LinkProperties.getNat64Prefix()`.
 */
data class Nat64Prefix(val prefix: String, val length: Int) {
  init {
    require(length in LAYOUT) { "Not an RFC 6052 prefix length: $length" }
  }

  /** The prefix's 16 bytes, or null if it isn't an IPv6 literal. */
  val bytes: IntArray? by lazy { IpPolicy.parseIPv6(prefix) }

  /** The IPv4 address embedded in [address] under this prefix, if the address is under it. */
  fun embeddedIPv4(address: IntArray): IntArray? {
    val prefixBytes = bytes ?: return null
    if (!IpPolicy.inRange(address, prefixBytes, length)) return null
    return LAYOUT.getValue(length).map { address[it] }.toIntArray()
  }

  companion object {
    /** Where RFC 6052 puts the IPv4 address after a prefix of each length (bits 64-71 are skipped). */
    val LAYOUT: Map<Int, IntArray> =
      mapOf(
        32 to intArrayOf(4, 5, 6, 7),
        40 to intArrayOf(5, 6, 7, 9),
        48 to intArrayOf(6, 7, 9, 10),
        56 to intArrayOf(7, 9, 10, 11),
        64 to intArrayOf(9, 10, 11, 12),
        96 to intArrayOf(12, 13, 14, 15),
      )
  }
}
