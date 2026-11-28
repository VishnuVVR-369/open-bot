package dev.openbot.securescreen

import android.app.Activity
import android.app.Application
import android.view.WindowManager
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * FLAG_SECURE on the app's window, on the oldest Android the app runs on (minSdk 29) and on
 * Android 14, where expo-screen-capture's screenshot listener needed a permission the app doesn't
 * hold. Nothing here may ask for one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 34])
class SecureScreenTest {
  private val application = ApplicationProvider.getApplicationContext<Application>()
  private val screen = SecureScreen(application).also { it.start() }

  @After fun stop() = screen.stop()

  private fun Activity.secure() =
    window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0

  @Test fun hidesTheWindowInFrontUntilAllowed() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    assertFalse(activity.secure())
    screen.set(true, activity)
    assertTrue(screen.on)
    assertTrue(activity.secure())
    screen.set(false, activity)
    assertFalse(activity.secure())
  }

  @Test fun staysHiddenWhenARotationRecreatesTheActivity() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    screen.set(true, controller.get())
    // A rotation destroys the activity and makes a new one, with a new window.
    controller.recreate()
    assertTrue(controller.get().secure())
    // And so does any activity the app opens while it's on, before its first frame.
    val created = Robolectric.buildActivity(Activity::class.java).create().get()
    assertTrue(created.secure())
  }

  @Test fun anActivityComingBackAfterItWasAllowedIsShown() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    screen.set(true, controller.get())
    controller.pause().stop()
    // Allowed while it was in the background (the vault locked and its screens closed).
    screen.set(false, null)
    controller.restart().resume()
    assertFalse(controller.get().secure())
  }

  /** Being told of screenshots needs DETECT_SCREEN_CAPTURE, which the app blocks: nothing here asks. */
  @Test fun asksToBeToldOfNoScreenshot() {
    val manifest = application.packageManager
      .getPackageInfo(application.packageName, android.content.pm.PackageManager.GET_PERMISSIONS)
    val asked = manifest.requestedPermissions.orEmpty().toList()
    assertFalse(asked.contains("android.permission.DETECT_SCREEN_CAPTURE"))
  }
}
