package dev.openbot.securescreen

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.WindowManager

/**
 * FLAG_SECURE on the app's windows while it's on: they stay out of screenshots, screen recordings,
 * casting and the recent apps preview. An activity made while it's on (a rotation recreates the
 * app's activity) gets it as it's created, before its first frame, and every activity is checked
 * again as it comes to the front. It asks for no permission and registers no screenshot listener
 * (Android 14's needs DETECT_SCREEN_CAPTURE, which the app doesn't hold). Call it on the main thread.
 */
class SecureScreen(private val application: Application) {
  var on = false
    private set

  private val callbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = apply(activity)
    override fun onActivityResumed(activity: Activity) = apply(activity)
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
  }

  fun start() = application.registerActivityLifecycleCallbacks(callbacks)

  fun stop() = application.unregisterActivityLifecycleCallbacks(callbacks)

  /** Turns it on or off, for the activity in front now and every one after it. */
  fun set(on: Boolean, current: Activity?) {
    this.on = on
    current?.let(::apply)
  }

  private fun apply(activity: Activity) {
    val window = activity.window ?: return
    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }
}
