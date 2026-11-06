package dev.openbot.egress.core

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** The vectors `packages/egress` generates, shared with the TypeScript implementation. */
object Vectors {
  private val dir = File(System.getProperty("egress.vectors") ?: error("egress.vectors is not set"))

  fun text(name: String) = File(dir, name).readText()

  fun obj(name: String) = JSONObject(text(name))

  fun array(name: String) = JSONArray(text(name))
}

fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

fun unhex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

fun sha256(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

/** A JSON value as plain Kotlin values, with every number as a Long or Double, for comparing. */
fun plain(value: Any?): Any? =
  when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> value.keys().asSequence().map { it as String }.associateWith { plain(value.opt(it)) }
    is JSONArray -> (0 until value.length()).map { plain(value.opt(it)) }
    is Int -> value.toLong()
    is Long -> value
    is Number -> value.toDouble().let { if (it == Math.floor(it)) it.toLong() else it }
    else -> value
  }

/** A scheduler on a fake clock: tasks run only when the test advances time. */
class FakeScheduler : Scheduler {
  private class Task(val at: Long, val run: () -> Unit) {
    var cancelled = false
  }

  var now = 0L
    private set

  private val tasks = mutableListOf<Task>()

  override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
    val entry = Task(now + delayMs, task)
    tasks.add(entry)
    return Cancellable { entry.cancelled = true }
  }

  fun advance(ms: Long) {
    val until = now + ms
    while (true) {
      val next = tasks.filter { !it.cancelled && it.at <= until }.minByOrNull { it.at } ?: break
      tasks.remove(next)
      now = next.at
      next.run()
    }
    now = until
  }
}

/** Events from another thread, read in order with a timeout. */
class Inbox<T> {
  private val queue = LinkedBlockingQueue<T>()

  fun put(value: T) = queue.put(value)

  fun take(timeoutMs: Long = 5_000): T =
    queue.poll(timeoutMs, TimeUnit.MILLISECONDS) ?: throw AssertionError("Nothing arrived within $timeoutMs ms")

  /** The next value matching [predicate], skipping others. */
  fun takeMatching(timeoutMs: Long = 5_000, predicate: (T) -> Boolean): T {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (true) {
      val left = deadline - System.currentTimeMillis()
      if (left <= 0) throw AssertionError("Nothing matching arrived within $timeoutMs ms")
      val value = queue.poll(left, TimeUnit.MILLISECONDS) ?: continue
      if (predicate(value)) return value
    }
  }

  fun poll(timeoutMs: Long): T? = queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
}
