package dev.openbot.passkey

import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.NoCredentialException
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A failed ceremony, with a code the app can act on: cancelled, none, unavailable or failed. */
class PasskeyException(code: String, message: String?, cause: Throwable? = null) :
  CodedException(code, message, cause)

/**
 * Android's Credential Manager, for passkeys. Takes and returns WebAuthn JSON, the same JSON the
 * server's passkey endpoints speak, so the app only passes it along.
 */
class PasskeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenBotPasskey")

    AsyncFunction("create") Coroutine { requestJson: String ->
      val activity = appContext.currentActivity
        ?: throw PasskeyException("failed", "open-bot isn't on screen.")
      try {
        val response =
          CredentialManager.create(activity)
            .createCredential(activity, CreatePublicKeyCredentialRequest(requestJson))
        (response as CreatePublicKeyCredentialResponse).registrationResponseJson
      } catch (error: CreateCredentialCancellationException) {
        throw PasskeyException("cancelled", error.errorMessage?.toString(), error)
      } catch (error: CreateCredentialNoCreateOptionException) {
        throw PasskeyException("unavailable", error.errorMessage?.toString(), error)
      } catch (error: CreateCredentialProviderConfigurationException) {
        throw PasskeyException("unavailable", error.errorMessage?.toString(), error)
      } catch (error: CreateCredentialException) {
        throw PasskeyException("failed", error.errorMessage?.toString() ?: error.type, error)
      }
    }

    AsyncFunction("get") Coroutine { requestJson: String ->
      val activity = appContext.currentActivity
        ?: throw PasskeyException("failed", "open-bot isn't on screen.")
      try {
        val response =
          CredentialManager.create(activity)
            .getCredential(
              activity,
              GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson))),
            )
        val credential =
          response.credential as? PublicKeyCredential
            ?: throw PasskeyException("failed", "That wasn't a passkey.")
        credential.authenticationResponseJson
      } catch (error: GetCredentialCancellationException) {
        throw PasskeyException("cancelled", error.errorMessage?.toString(), error)
      } catch (error: NoCredentialException) {
        throw PasskeyException("none", error.errorMessage?.toString(), error)
      } catch (error: GetCredentialProviderConfigurationException) {
        throw PasskeyException("unavailable", error.errorMessage?.toString(), error)
      } catch (error: GetCredentialException) {
        throw PasskeyException("failed", error.errorMessage?.toString() ?: error.type, error)
      }
    }
  }
}
