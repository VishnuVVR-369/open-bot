package dev.openbot.share

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Text another app shares into open-bot (Android's share sheet, ACTION_SEND text/plain).
 * A share is handed to JS once: the one the app was opened with through take(), later ones
 * through the "share" event as they arrive.
 */
class ShareIntentModule : Module() {
  /** The intent already read, so the same share isn't handed over twice. */
  private var consumed: Intent? = null

  private fun read(intent: Intent?): Map<String, String?>? {
    if (intent == null || intent === consumed) return null
    if (intent.action != Intent.ACTION_SEND) return null
    // Reopened from recents: Android hands back the share it was first opened with.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    val type = intent.type ?: return null
    if (!type.startsWith("text/")) return null
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    consumed = intent
    if (text.isNullOrBlank() && subject.isNullOrBlank()) return null
    return mapOf("text" to (text ?: ""), "subject" to subject)
  }

  override fun definition() = ModuleDefinition {
    Name("OpenBotShareIntent")
    Events("share")
    Function("take") { read(appContext.currentActivity?.intent) }
    OnNewIntent { intent ->
      val share = read(intent) ?: return@OnNewIntent
      sendEvent("share", share)
    }
  }
}
