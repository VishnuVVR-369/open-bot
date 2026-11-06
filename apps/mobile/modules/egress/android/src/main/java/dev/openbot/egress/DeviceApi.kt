package dev.openbot.egress

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import dev.openbot.egress.core.UnavailableReason
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** The web routes a paired phone calls with its device credential (no session). */
object DeviceApi {
  enum class Outcome {
    DONE,
    /** `401`: this credential was turned off. Final. */
    REVOKED,
    /** The network or the server failed: try again later. */
    RETRY,
    /** The server refused the request itself: trying again won't help. */
    DROPPED,
  }

  private val client by lazy {
    OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
  }

  fun post(pairing: Pairing, path: String, body: JSONObject): Outcome {
    val request =
      Request.Builder()
        .url(pairing.appUrl.trimEnd('/') + path)
        .header("Authorization", "Bearer ${pairing.credential.secret}")
        .header("x-device-id", pairing.credential.deviceId)
        .post(body.toString().toRequestBody("application/json".toMediaType()))
        .build()
    return try {
      client.newCall(request).execute().use { response ->
        when {
          response.isSuccessful -> Outcome.DONE
          response.code == 401 -> Outcome.REVOKED
          response.code >= 500 || response.code == 429 -> Outcome.RETRY
          else -> Outcome.DROPPED
        }
      }
    } catch (error: IOException) {
      Log.w(TAG, "$path failed, will retry: $error")
      Outcome.RETRY
    }
  }
}

/**
 * Reports and token updates, through WorkManager so they are persisted the moment they are
 * enqueued and survive process death, retried with backoff until the network allows.
 */
object DeviceWork {
  private const val REASON = "reason"
  private const val GENERATION = "generation"
  private const val SEQ = "seq"
  private const val UNAVAILABLE_WORK = "egress-unavailable"
  private const val PUSH_TOKEN_WORK = "egress-push-token"

  private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

  /** Tell the worker this phone can't help right now, so it stops waking it for a while. */
  fun reportUnavailable(context: Context, reason: UnavailableReason, seq: Long = ReportSeq.next(context)) {
    val pairing = CredentialStore.read(context) ?: return
    val request =
      OneTimeWorkRequest.Builder(UnavailableWorker::class.java)
        .setInputData(
          Data.Builder()
            .putString(REASON, reason.wire)
            .putInt(GENERATION, pairing.credential.generation)
            .putLong(SEQ, seq)
            .build()
        )
        .setConstraints(online)
        // Soon, before the worker's next wake: its retry comes 30 seconds after the first.
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
        .build()
    // Only the latest reason matters.
    WorkManager.getInstance(context).enqueueUniqueWork(UNAVAILABLE_WORK, ExistingWorkPolicy.REPLACE, request)
  }

  /** The phone is connected again: a report not sent yet is out of date. */
  fun cancelUnavailable(context: Context) {
    WorkManager.getInstance(context).cancelUniqueWork(UNAVAILABLE_WORK)
  }

  /** The pairing is gone: nothing is left to send for it. */
  fun cancelAll(context: Context) {
    WorkManager.getInstance(context).run {
      cancelUniqueWork(UNAVAILABLE_WORK)
      cancelUniqueWork(PUSH_TOKEN_WORK)
    }
  }

  /** Send the newest FCM token; a newer one replaces a pending update. */
  fun updatePushToken(context: Context, token: String) {
    Settings.setPushToken(context, token)
    if (CredentialStore.read(context) == null) return // Pairing sends the token itself.
    val request =
      OneTimeWorkRequest.Builder(PushTokenWorker::class.java)
        .setConstraints(online)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork(PUSH_TOKEN_WORK, ExistingWorkPolicy.REPLACE, request)
  }

  internal fun reasonOf(data: Data) = UnavailableReason.fromWire(data.getString(REASON))

  internal fun seqOf(data: Data): Long? = data.getLong(SEQ, -1).takeIf { it >= 0 }

  internal fun generationOf(data: Data) = data.getInt(GENERATION, -1)
}

private fun Context.finish(outcome: DeviceApi.Outcome, pairing: Pairing): androidx.work.ListenableWorker.Result =
  when (outcome) {
    DeviceApi.Outcome.DONE,
    DeviceApi.Outcome.DROPPED -> androidx.work.ListenableWorker.Result.success()
    DeviceApi.Outcome.RETRY -> androidx.work.ListenableWorker.Result.retry()
    DeviceApi.Outcome.REVOKED -> {
      Egress.revoked(this, pairing.credential.generation)
      androidx.work.ListenableWorker.Result.success()
    }
  }

class UnavailableWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val reason = DeviceWork.reasonOf(inputData) ?: return Result.success()
    val pairing = CredentialStore.read(applicationContext) ?: return Result.success()
    // Reported for a pairing that has since been replaced: the new one starts clean.
    if (pairing.credential.generation != DeviceWork.generationOf(inputData)) return Result.success()
    val seq = DeviceWork.seqOf(inputData)
    // The phone has connected since (and said so), for example while this waited for a retry.
    if (seq != null && ReportSeq.acknowledged(applicationContext, seq)) return Result.success()
    val body = JSONObject().put("reason", reason.wire)
    seq?.let { body.put("seq", it) }
    val outcome = DeviceApi.post(pairing, "/api/egress/device/unavailable", body)
    return applicationContext.finish(outcome, pairing)
  }

  // Expedited work on Android 11 and older runs as a foreground service, which needs a notice.
  override fun getForegroundInfo() = Notices.workForegroundInfo(applicationContext)
}

class PushTokenWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val token = Settings.pushToken(applicationContext) ?: return Result.success()
    val pairing = CredentialStore.read(applicationContext) ?: return Result.success()
    val outcome = DeviceApi.post(pairing, "/api/egress/device/push-token", JSONObject().put("token", token))
    return applicationContext.finish(outcome, pairing)
  }
}
