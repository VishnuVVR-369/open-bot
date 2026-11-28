package dev.openbot.securescreen

import android.app.Application
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The app's JavaScript side of `SecureScreen`: on while a vault screen is in front. Every change
 * runs on the main thread, in the order it was asked, where window flags may be changed.
 */
class SecureScreenModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  /** Made on the first change, and only touched on the main thread. */
  private var screen: SecureScreen? = null

  private fun change(on: Boolean) {
    val application = appContext.reactContext?.applicationContext as? Application ?: return
    main.post {
      val current = screen ?: SecureScreen(application).also { it.start(); screen = it }
      current.set(on, appContext.currentActivity)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("OpenBotSecureScreen")
    Function("prevent") { change(true) }
    Function("allow") { change(false) }
    // A JavaScript reload starts counting the screens from none, so nothing stays hidden.
    OnDestroy {
      val activity = appContext.currentActivity
      main.post {
        screen?.set(false, activity)
        screen?.stop()
        screen = null
      }
    }
  }
}
