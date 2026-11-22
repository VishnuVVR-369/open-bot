package dev.openbot.runprogress

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The app's JavaScript side of `RunProgress`. */
class RunProgressModule : Module() {
  private val context get() = appContext.reactContext ?: throw IllegalStateException("App unavailable")

  override fun definition() = ModuleDefinition {
    Name("OpenBotRunProgress")
    /** A `run-progress` push the app received itself (development builds have no FCM service). */
    Function("handle") { data: Map<String, String> -> RunProgress.onPush(context, data) }
    Function("endRun") { runId: String -> RunProgress.endRun(context, runId) }
    Function("setVisibleChat") { chatId: String? -> RunProgress.setVisibleChat(context, chatId) }
  }
}
