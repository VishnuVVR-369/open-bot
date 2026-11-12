package dev.openbot.egress.core

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** The Kotlin core against the vectors the TypeScript implementation generates. */
class VectorsTest {
  @Test
  fun `constants match`() {
    val constants = Vectors.obj("frames.json").getJSONObject("constants")
    assertEquals(constants.getLong("initialWindow"), INITIAL_WINDOW)
    assertEquals(constants.getInt("maxFramePayload"), MAX_FRAME_PAYLOAD)
    assertEquals(constants.getLong("maxInFlight"), MAX_IN_FLIGHT)
    assertEquals(constants.getString("agentGone"), Frames.AGENT_GONE)
  }

  @Test
  fun `enums carry the same wire values`() {
    val enums = Vectors.obj("frames.json").getJSONObject("enums")
    fun wire(name: String) = enums.getJSONArray(name).let { list -> List(list.length()) { list.getString(it) } }
    assertEquals(wire("egressMode"), EgressMode.entries.map { it.wire })
    assertEquals(wire("phoneMode"), PhoneMode.entries.map { it.wire })
    assertEquals(wire("agentRole"), AgentRole.entries.map { it.wire })
    assertEquals(wire("unavailableReason"), UnavailableReason.entries.map { it.wire })
  }

  @Test
  fun `frames encode and decode`() {
    val vectors = Vectors.obj("frames.json")
    for (case in vectors.getJSONArray("valid").objects()) {
      val type = case.getInt("type")
      val streamId = case.getLong("streamId")
      val payload = unhex(case.getString("payload"))
      val encoded = unhex(case.getString("encoded"))
      assertEquals(case.getString("encoded"), hex(Frames.encode(type, streamId, payload)))
      val frame = Frames.decode(encoded)
      assertEquals(type, frame.type)
      assertEquals(streamId, frame.streamId)
      assertArrayEquals(payload, frame.payload)
    }
    val largest = vectors.getJSONObject("largest")
    val fill = largest.getJSONArray("fill")
    val payload = ByteArray(fill.getInt(0)) { fill.getInt(1).toByte() }
    val encoded = Frames.encode(largest.getInt("type"), largest.getLong("streamId"), payload)
    assertEquals(largest.getInt("encodedLength"), encoded.size)
    assertEquals(largest.getString("encodedSha256"), sha256(encoded))
    for (case in vectors.getJSONArray("invalid").objects())
      assertThrows<MalformedFrameException>(case.toString()) { Frames.decode(unhex(case.getString("encoded"))) }
  }

  @Test
  fun `control messages parse like the TypeScript side`() {
    for (case in Vectors.array("control.json").objects()) {
      val text = case.getString("text")
      val expected = plain(case.opt("parsed"))
      val parsed = Control.parse(text)
      assertEquals(expected, parsed?.let { plain(Control.toJson(it)) }, text)
      // What this side writes, the other parses back to the same message.
      if (parsed != null) assertEquals(parsed, Control.parse(Control.encode(parsed)), text)
    }
  }

  private fun prefixes(case: JSONObject): List<Nat64Prefix> =
    case.optJSONArray("nat64")?.objects()?.map { Nat64Prefix(it.getString("prefix"), it.getInt("length")) }
      ?: emptyList()

  @Test
  fun `the ip policy decides every address the same way`() {
    val policy = Vectors.obj("ip-policy.json").getJSONArray("policy")
    for (case in policy.objects()) {
      val address = case.getString("address")
      assertEquals(case.getBoolean("public"), IpPolicy.isPublicAddress(address, prefixes(case)), case.toString())
    }
  }

  @Test
  fun `names resolve to the same choice`() {
    val resolutions = Vectors.obj("ip-policy.json").getJSONArray("resolutions")
    for (case in resolutions.objects()) {
      val answers =
        case.getJSONArray("answers").objects().map {
          ResolvedAddress(it.getString("address"), it.getInt("family"), it.getString("address"))
        }
      val outcome =
        try {
          Destinations.choose(case.getString("host"), prefixes(case), { it }, { answers })
        } catch (_: BlockedDestinationException) {
          "error:blocked"
        } catch (_: UnresolvedHostException) {
          "error:unresolved"
        }
      val expected = if (case.has("error")) "error:" + case.getString("error") else case.getString("result")
      assertEquals(expected, outcome, case.toString())
    }
  }

  @Test
  fun `NAT64 prefixes decode in every RFC 6052 layout`() {
    // RFC 6052 section 2.4's examples, each embedding 192.0.2.33.
    val examples =
      listOf(
        Nat64Prefix("2001:db8::", 32) to "2001:db8:c000:221::",
        Nat64Prefix("2001:db8:100::", 40) to "2001:db8:1c0:2:21::",
        Nat64Prefix("2001:db8:122::", 48) to "2001:db8:122:c000:2:2100::",
        Nat64Prefix("2001:db8:122:300::", 56) to "2001:db8:122:3c0:0:221::",
        Nat64Prefix("2001:db8:122:344::", 64) to "2001:db8:122:344:c0:2:2100::",
        Nat64Prefix("2001:db8:122:344::", 96) to "2001:db8:122:344::c000:221",
      )
    for ((prefix, address) in examples) {
      val embedded = prefix.embeddedIPv4(IpPolicy.parseIPv6(address)!!)
      assertArrayEquals(intArrayOf(192, 0, 2, 33), embedded, address)
    }
    assertThrows<IllegalArgumentException> { Nat64Prefix("2001:db8::", 33) }
  }
}
