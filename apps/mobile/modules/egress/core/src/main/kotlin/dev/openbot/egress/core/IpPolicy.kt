package dev.openbot.egress.core

/**
 * Destinations the agent refuses, so a teammate can never reach devices on your home network or
 * your carrier's. The same rules, over raw address bytes, as `packages/egress/src/ip-policy.ts`;
 * `test-vectors/ip-policy.json` keeps the two in step.
 */
object IpPolicy {
  private class Range(val prefix: IntArray, val bits: Int)

  private fun v4(a: Int, b: Int, c: Int, d: Int, bits: Int) = Range(intArrayOf(a, b, c, d), bits)

  private fun v6(bits: Int, vararg groups: Int) =
    Range(groups.flatMap { listOf(it shr 8, it and 0xff) }.toIntArray(), bits)

  private val BLOCKED_V4 =
    listOf(
      v4(0, 0, 0, 0, 8), // "this" network
      v4(10, 0, 0, 0, 8), // private
      v4(100, 64, 0, 0, 10), // carrier-grade NAT
      v4(127, 0, 0, 0, 8), // loopback
      v4(169, 254, 0, 0, 16), // link-local
      v4(172, 16, 0, 0, 12), // private
      v4(192, 0, 0, 0, 24), // IETF protocol assignments
      v4(192, 168, 0, 0, 16), // private
      v4(198, 18, 0, 0, 15), // benchmarking
      v4(224, 0, 0, 0, 4), // multicast
      v4(240, 0, 0, 0, 4), // reserved and broadcast
    )

  private val BLOCKED_V6 =
    listOf(
      v6(96, 0, 0, 0, 0, 0, 0), // unspecified, loopback and IPv4-compatible (::a.b.c.d)
      v6(48, 0x64, 0xff9b, 1), // local-use NAT64, which can translate to anything
      v6(64, 0x100, 0, 0, 0), // discard-only
      v6(32, 0x2001, 0), // Teredo, which tunnels to an address the policy can't see
      v6(32, 0x2001, 0xdb8), // documentation
      v6(7, 0xfc00), // unique local
      v6(10, 0xfe80), // link-local
      v6(10, 0xfec0), // site-local (deprecated, but still private where used)
      v6(8, 0xff00), // multicast
    )

  /** IPv6 ranges that carry an IPv4 address, and where: the IPv4 rules decide those. */
  private val EMBEDDING_V6 =
    listOf(
      v6(96, 0, 0, 0, 0, 0, 0xffff) to 12, // IPv4-mapped
      v6(96, 0x64, 0xff9b, 0, 0, 0, 0) to 12, // NAT64 well-known prefix
      v6(16, 0x2002) to 2, // 6to4
    )

  private val V4_PART = Regex("^(0|[1-9][0-9]{0,2})$")
  private val V6_GROUP = Regex("^[0-9a-fA-F]{1,4}$")

  internal fun inRange(bytes: IntArray, prefix: IntArray, bits: Int): Boolean {
    var bit = 0
    while (bit < bits) {
      val index = bit / 8
      val width = minOf(8, bits - bit)
      val mask = (0xff shl (8 - width)) and 0xff
      if ((bytes.getOrElse(index) { 0 } and mask) != (prefix.getOrElse(index) { 0 } and mask)) return false
      bit += 8
    }
    return true
  }

  private fun inRange(bytes: IntArray, range: Range) = inRange(bytes, range.prefix, range.bits)

  /** The 4 bytes of an IPv4 literal, or null. */
  fun parseIPv4(text: String): IntArray? {
    val parts = text.split(".")
    if (parts.size != 4) return null
    val bytes = IntArray(4)
    for ((index, part) in parts.withIndex()) {
      if (!V4_PART.matches(part)) return null
      val value = part.toInt()
      if (value > 255) return null
      bytes[index] = value
    }
    return bytes
  }

  /** The 16 bytes of an IPv6 literal (with an optional embedded IPv4 tail), or null. */
  fun parseIPv6(text: String): IntArray? {
    if (text.contains('%')) return null // zone ids only make sense for local addresses
    var head = text
    var tail: IntArray? = null
    val lastColon = text.lastIndexOf(':')
    if (text.indexOf('.', maxOf(lastColon, 0)) >= 0) {
      tail = parseIPv4(text.substring(lastColon + 1)) ?: return null
      // Two placeholder groups stand in for the dotted tail, so the group count works out.
      head = text.substring(0, lastColon + 1) + "0:0"
    }
    val halves = head.split("::")
    if (halves.size > 2) return null
    fun groupsOf(part: String) = if (part.isEmpty()) emptyList() else part.split(":")
    val left = groupsOf(halves[0])
    val right = if (halves.size == 2) groupsOf(halves[1]) else emptyList()
    if (halves.size == 2 && left.size + right.size > 7) return null
    val groups =
      if (halves.size == 2) left + List(8 - left.size - right.size) { "0" } + right else left
    if (groups.size != 8) return null
    val bytes = IntArray(16)
    for ((index, group) in groups.withIndex()) {
      if (!V6_GROUP.matches(group)) return null
      val value = group.toInt(16)
      bytes[index * 2] = value shr 8
      bytes[index * 2 + 1] = value and 0xff
    }
    tail?.copyInto(bytes, 12)
    return bytes
  }

  private fun isPublicV4(bytes: IntArray): Boolean = BLOCKED_V4.none { inRange(bytes, it) }

  private fun isPublicV6(bytes: IntArray, nat64: List<Nat64Prefix>): Boolean {
    for ((range, offset) in EMBEDDING_V6)
      if (inRange(bytes, range)) return isPublicV4(bytes.copyOfRange(offset, offset + 4))
    for (prefix in nat64) {
      val embedded = prefix.embeddedIPv4(bytes) ?: continue
      return isPublicV4(embedded)
    }
    return BLOCKED_V6.none { inRange(bytes, it) }
  }

  /** Whether the agent may connect to this IP address. Anything that isn't an IP literal is refused. */
  fun isPublicAddress(address: String, nat64: List<Nat64Prefix> = emptyList()): Boolean {
    parseIPv4(address)?.let { return isPublicV4(it) }
    parseIPv6(address)?.let { return isPublicV6(it, nat64) }
    return false
  }

  /** Removes the brackets of an IPv6 literal written as a URL host. */
  fun unbracket(host: String): String =
    if (host.startsWith("[") && host.endsWith("]")) host.substring(1, host.length - 1) else host

  /**
   * Whether [host] is written as an IP address rather than a name. Anything with a colon counts,
   * since no name has one: it is then checked as an address and refused if it isn't a valid one.
   */
  fun isLiteral(host: String): Boolean {
    val literal = unbracket(host)
    return parseIPv4(literal) != null || literal.contains(':')
  }
}

class BlockedDestinationException(host: String) :
  Exception("Refused to connect to $host: private and local addresses are blocked")

class UnresolvedHostException(host: String) : Exception("Could not resolve $host")

/** One answer from a name lookup. */
data class ResolvedAddress<T>(val address: String, val family: Int, val value: T)

object Destinations {
  /**
   * Pick a public address for [host] to connect to, from [resolve]'s answers. Connecting to the
   * address that was checked (not the name) prevents DNS rebinding between the check and the use.
   * A name with any private address is refused as a whole, so it can't mix both.
   */
  fun <T> choose(
    host: String,
    nat64: List<Nat64Prefix>,
    literal: (String) -> T,
    resolve: (String) -> List<ResolvedAddress<T>>,
  ): T {
    val bare = IpPolicy.unbracket(host)
    if (IpPolicy.isLiteral(host)) {
      if (!IpPolicy.isPublicAddress(bare, nat64)) throw BlockedDestinationException(host)
      return literal(bare)
    }
    val answers = resolve(bare)
    if (answers.isEmpty()) throw UnresolvedHostException(host)
    if (answers.any { !IpPolicy.isPublicAddress(it.address, nat64) })
      throw BlockedDestinationException(host)
    return (answers.firstOrNull { it.family == 4 } ?: answers.first()).value
  }
}
