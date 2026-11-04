package dev.openbot.sms

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Reads one message only after Android's consent dialog. Neither SMS nor code is persisted. */
class SmsConsentModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private var listening = false
  private var requestCode = 49124
  private var generation = 0

  private fun stop() {
    generation += 1
    listening = false
    receiver?.let { runCatching { appContext.reactContext?.unregisterReceiver(it) } }
    receiver = null
  }

  override fun definition() = ModuleDefinition {
    Name("OpenBotSmsConsent")
    Events("code")
    AsyncFunction("start") {
      stop()
      val current = generation
      requestCode = if (requestCode >= 60000) 49124 else requestCode + 1
      val consentRequestCode = requestCode
      val context = appContext.reactContext ?: throw IllegalStateException("App unavailable")
      listening = true
      receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          if (!listening || generation != current || intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
          val status = intent.extras?.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return
          if (status.statusCode == CommonStatusCodes.SUCCESS) {
            val consent = intent.extras?.get(SmsRetriever.EXTRA_CONSENT_INTENT) as? Intent ?: return
            appContext.currentActivity?.runOnUiThread {
              if (generation != current) return@runOnUiThread
              runCatching { appContext.currentActivity?.startActivityForResult(consent, consentRequestCode) }
                .onFailure { stop(); sendEvent("code", mapOf("code" to null)) }
            }
          } else { stop(); sendEvent("code", mapOf("code" to null)) }
        }
      }
      ContextCompat.registerReceiver(context, receiver, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION), SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
      SmsRetriever.getClient(context).startSmsUserConsent(null).addOnFailureListener {
        if (generation == current) { stop(); sendEvent("code", mapOf("code" to null)) }
      }
    }
    Function("stop") { stop() }
    OnDestroy { stop() }
    OnActivityDestroys { stop() }
    OnActivityResult { _, result -> consumeResult(result.requestCode, result.resultCode, result.data) }
  }

  private fun consumeResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != this.requestCode || !listening) return
    val message = if (resultCode == Activity.RESULT_OK) data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE) else null
    val candidates = message?.let { Regex("(?<!\\d)\\d{4,8}(?!\\d)").findAll(it).map { m -> m.value }.distinct().toList() }
    val code = if (candidates?.size == 1) candidates.first() else null
    stop()
    sendEvent("code", mapOf("code" to code))
  }
}
