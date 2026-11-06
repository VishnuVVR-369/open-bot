package dev.openbot.egress

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import dev.openbot.egress.core.DeviceCredential
import dev.openbot.egress.core.PhoneMode
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService

private const val EGRESS_NEEDED = "egress-needed"

/**
 * Takes FCM's service slot from React Native Firebase (whose own service does nothing with
 * messages) and handles `egress-needed` natively; everything else goes through RN Firebase.
 */
class EgressMessagingService : ReactNativeFirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    if (message.data["type"] == EGRESS_NEEDED) Egress.onEgressNeeded(this, message.data)
    else super.onMessageReceived(message)
  }

  override fun onNewToken(token: String) {
    super.onNewToken(token)
    DeviceWork.updatePushToken(this, token)
  }
}

/**
 * Replaces React Native Firebase's receiver, which starts headless JavaScript for every message
 * the app gets in the background. Egress pushes never start JavaScript.
 */
class EgressMessagingReceiver : ReactNativeFirebaseMessagingReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.getStringExtra("type") == EGRESS_NEEDED) return
    super.onReceive(context, intent)
  }
}

/** In `always`, the phone connection starts with the phone. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (CredentialStore.read(context) == null || Settings.phoneMode(context) != PhoneMode.ALWAYS) return
    val phase = RunStateStore.read(context).phase
    if (phase == RunPhase.STOPPED || phase == RunPhase.REVOKED) return
    Egress.start(context, EgressService.ACTION_ALWAYS)
  }
}

/**
 * Development builds only (they have no Firebase), and only from the shell (the manifest
 * requires `android.permission.DUMP`):
 *
 * - `dev.openbot.egress.DEBUG_WAKE` with `--es stage wake --es sentAt <ISO time>`: the same data
 *   as a wake push, through the same code.
 * - `dev.openbot.egress.DEBUG_PAIR` with `--es secret … --ei generation … --es appUrl …
 *   [--es phoneMode always]`: pair without the app's screens (scripts/egress-pair-dev.mjs).
 */
class DebugWakeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      "dev.openbot.egress.DEBUG_PAIR" -> pair(context, intent)
      else -> {
        val data = listOf("stage", "sentAt", "title", "body", "phoneMode").mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap()
        Log.i(TAG, "Debug wake: $data")
        Egress.onEgressNeeded(context, data)
      }
    }
  }

  private fun pair(context: Context, intent: Intent) {
    // Made on first use, so a script can read it before registering the device.
    Log.i(TAG, "Debug pair: device id ${CredentialStore.deviceId(context)}")
    val secret = intent.getStringExtra("secret") ?: return // Only the device id was asked for.
    val appUrl = intent.getStringExtra("appUrl")
    val generation = intent.getIntExtra("generation", 0)
    val mode = PhoneMode.fromWire(intent.getStringExtra("phoneMode") ?: "fallback")
    if (secret.isEmpty() || appUrl.isNullOrEmpty() || generation < 1 || mode == null) {
      Log.w(TAG, "Debug pair: missing secret, appUrl, generation or a valid phoneMode")
      return
    }
    Log.i(TAG, "Debug pair: pairing generation $generation with $appUrl in $mode")
    Egress.pair(context, Pairing(DeviceCredential(CredentialStore.deviceId(context), secret, generation), appUrl), mode)
  }
}
