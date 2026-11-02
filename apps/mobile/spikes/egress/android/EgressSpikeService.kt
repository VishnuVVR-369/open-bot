package dev.openbot.mobile.spike

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dev.openbot.mobile.R
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Stands in for phase 3's egress agent: a `specialUse` foreground service that opens one
 * websocket, proves it carries data, holds it for a while, then stops.
 */
class EgressSpikeService : Service() {
  private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
  private val main = Handler(Looper.getMainLooper())
  private var socket: WebSocket? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val case = intent?.getStringExtra("case") ?: "unlabelled"
    val receivedAt = intent?.getLongExtra("receivedAt", 0L) ?: 0L
    val since = { System.currentTimeMillis() - receivedAt }
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification(case),
        if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
      )
      SpikeLog.write(this, "fgs-started", mapOf("case" to case, "sincePushMs" to since()))
    } catch (error: Exception) {
      SpikeLog.write(
        this,
        "fgs-start-failed",
        mapOf("case" to case, "error" to error.javaClass.name, "message" to error.message),
      )
      stopSelf()
      return START_NOT_STICKY
    }
    socket?.cancel()
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock =
      (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openbot:egress-spike")
        .apply { acquire(HOLD_MS + 30_000) }
    val dialedAt = System.currentTimeMillis()
    socket =
      client.newWebSocket(
        Request.Builder().url(ECHO_URL).build(),
        object : WebSocketListener() {
          private var echoed = false

          override fun onOpen(webSocket: WebSocket, response: Response) {
            SpikeLog.write(
              this@EgressSpikeService,
              "ws-open",
              mapOf(
                "case" to case,
                "connectMs" to System.currentTimeMillis() - dialedAt,
                "sincePushMs" to since(),
              ),
            )
            webSocket.send("egress-spike $case $dialedAt")
          }

          override fun onMessage(webSocket: WebSocket, text: String) {
            if (echoed || !text.startsWith("egress-spike")) return
            echoed = true
            SpikeLog.write(
              this@EgressSpikeService,
              "ws-echo",
              mapOf("case" to case, "sincePushMs" to since()),
            )
            main.postDelayed(
              {
                webSocket.close(1000, "done")
                SpikeLog.write(
                  this@EgressSpikeService,
                  "ws-held",
                  mapOf("case" to case, "heldMs" to HOLD_MS, "sincePushMs" to since()),
                )
                finish()
              },
              HOLD_MS,
            )
          }

          override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
            SpikeLog.write(
              this@EgressSpikeService,
              "ws-failed",
              mapOf(
                "case" to case,
                "error" to error.javaClass.name,
                "message" to error.message,
                "sincePushMs" to since(),
              ),
            )
            main.post { finish() }
          }
        },
      )
    return START_NOT_STICKY
  }

  private fun finish() {
    wakeLock?.takeIf { it.isHeld }?.release()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    socket?.cancel()
    wakeLock?.takeIf { it.isHeld }?.release()
    super.onDestroy()
  }

  private fun notification(case: String): android.app.Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) == null)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Phone connection", NotificationManager.IMPORTANCE_LOW)
      )
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Connecting your phone")
      .setContentText("Egress spike: $case")
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val CHANNEL = "connection"
    private const val NOTIFICATION_ID = 4210
    private const val HOLD_MS = 60_000L
    private const val ECHO_URL = "wss://echo.websocket.org"
  }
}
