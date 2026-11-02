package dev.openbot.mobile.spike

import android.content.Intent
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.RemoteMessage
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService

/**
 * Takes FCM's service slot from React Native Firebase (whose own service does nothing with
 * messages: its receiver hands them to JavaScript), and starts the egress service natively for
 * an `egress-spike` message, with no JavaScript involved.
 */
class SpikeMessagingService : ReactNativeFirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    if (message.data["type"] != "egress-spike") return super.onMessageReceived(message)
    val receivedAt = System.currentTimeMillis()
    val case = message.data["case"] ?: "unlabelled"
    val sentAt = message.data["sentAtMs"]?.toLongOrNull()
    SpikeLog.write(
      this,
      "push",
      mapOf(
        "case" to case,
        "sentAtMs" to sentAt,
        "fcmSentTime" to message.sentTime,
        "pushDelayMs" to sentAt?.let { receivedAt - it },
        "priority" to priorityName(message.priority),
        "originalPriority" to priorityName(message.originalPriority),
      ) + SpikeLog.deviceState(this),
    )
    val intent =
      Intent(this, EgressSpikeService::class.java)
        .putExtra("case", case)
        .putExtra("receivedAt", receivedAt)
    try {
      ContextCompat.startForegroundService(this, intent)
      SpikeLog.write(this, "fgs-requested", mapOf("case" to case))
    } catch (error: Exception) {
      // ForegroundServiceStartNotAllowedException on Android 12+ when the app may not start one.
      SpikeLog.write(
        this,
        "fgs-start-refused",
        mapOf("case" to case, "error" to error.javaClass.name, "message" to error.message),
      )
    }
  }

  override fun onCreate() {
    super.onCreate()
    // So the sender has the token: any push (Settings → Send a test notification) creates this.
    FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
      SpikeLog.write(this, "token", mapOf("token" to token))
    }
  }

  override fun onNewToken(token: String) {
    super.onNewToken(token)
    SpikeLog.write(this, "token", mapOf("token" to token))
  }

  private fun priorityName(priority: Int) =
    when (priority) {
      RemoteMessage.PRIORITY_HIGH -> "high"
      RemoteMessage.PRIORITY_NORMAL -> "normal"
      else -> "unknown"
    }
}
