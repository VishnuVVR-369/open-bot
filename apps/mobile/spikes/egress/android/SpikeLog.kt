package dev.openbot.mobile.spike

import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.PowerManager
import android.util.Log
import java.io.File
import org.json.JSONObject

/** One JSON line per event, in logcat and in a file `adb pull` can read after the phone was unplugged. */
object SpikeLog {
  fun write(context: Context, event: String, fields: Map<String, Any?> = emptyMap()) {
    val json = JSONObject()
    json.put("event", event)
    json.put("at", System.currentTimeMillis())
    for ((key, value) in fields) json.put(key, value ?: JSONObject.NULL)
    val line = json.toString()
    Log.i("EgressSpike", line)
    val dir = context.getExternalFilesDir(null) ?: context.filesDir
    synchronized(this) { File(dir, "egress-spike.log").appendText(line + "\n") }
  }

  /** What decides whether Android lets the app start work in the background. */
  fun deviceState(context: Context): Map<String, Any?> {
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    return mapOf(
      "screenOn" to power.isInteractive,
      "dozing" to power.isDeviceIdleMode,
      "batterySaver" to power.isPowerSaveMode,
      "batteryOptimizationExempt" to power.isIgnoringBatteryOptimizations(context.packageName),
      "standbyBucket" to usage.appStandbyBucket,
    )
  }
}
