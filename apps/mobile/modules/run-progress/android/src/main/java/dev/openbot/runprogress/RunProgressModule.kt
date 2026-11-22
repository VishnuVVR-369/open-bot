package dev.openbot.runprogress

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The app's JavaScript side of `RunProgress`. */
class RunProgressModule : Module() {
  private val context get() = appContext.reactContext ?: throw IllegalStateException("App unavailable")

  override fun definition() = ModuleDefinition {
    Name("OpenBotRunProgress")
    /** A `run-progress` push the app received itself (development builds have no FCM service). */
    Function("handle") { data: Map<String, String> -> RunProgress.onPush(context, data, fromApp = true) }
    /** This sign-in's registration id, sent with the FCM token; pushes for any other are dropped. */
    Function("registration") { RunProgress.registration(context) }
    Function("endRun") { runId: String -> RunProgress.endRun(context, runId) }
    Function("setVisibleChat") { chatId: String? -> RunProgress.setVisibleChat(context, chatId) }
    /** On sign-out: every progress notification goes, and what the phone kept to draw them. */
    Function("reset") { RunProgress.reset(context) }
  }
}
