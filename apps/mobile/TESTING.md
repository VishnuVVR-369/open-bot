# Pocket inbox verification

Branch: `feat/mobile-pocket-inbox`.
Device: Redmi Note 10 Pro (`d05c2392`), Android 13 / MIUI 14.
Testing uses the separate `dev.openbot.mobile.dev` app and the local web, worker and computer.
The daily signed app and its production data are separate.

## Automated checks

| Check                                                   | Result                               |
| ------------------------------------------------------- | ------------------------------------ |
| Repository lint                                         | Passed, no warnings                  |
| Repository typecheck                                    | Passed, all 12 tasks                 |
| Unit tests                                              | Passed, all 9 tasks; 73 mobile tests |
| Disposable database mobile API suite                    | 20 passed                            |
| Disposable database bot management suite                | 18 passed                            |
| Isolated memory integration tests and worker smoke test | 40 passed; smoke passed              |
| Isolated memory browser regression                      | 6 passed                             |
| Web regression excluding real-model `@agent` scenarios  | 54 passed, 8 skipped                 |
| Android Maestro suite                                   | Staged checks; see limits below      |
| Web production build                                    | Passed                               |
| Worker production build                                 | Passed                               |
| Signed Android release build and signature verification | Passed                               |

The normal unit command skips integration tests that require disposable databases.
The dedicated commands above run those relevant integration suites explicitly.
The standard web regression has eight opt-in skips: six memory scenarios, one Telegram stand-in scenario and the fallback rehearsal.
The six memory scenarios are also run separately against their isolated stack.
The full real-model `@agent` web suite is excluded; the phone suite sends real messages through the local worker and computer.

## Fixes from the completion pass

- Approval decisions, chat renames and chat archives on another device now invalidate open detail screens as well as their lists.
  The stale approval was reproduced on the phone before fixing it.
- Foreground reconnection preserves the latest live event cursor rather than falling back to an older snapshot cursor.
- Only the focused chat subscribes to the shared stream, so refreshing a mounted screen behind it cannot replace its subscription.
- Dictation cancellation stays current when the chat loses focus, even when cleanup was registered before listening started.
- An unreadable picked file becomes a failed attachment with a useful message.
  Cancelling while upload headers load prevents the transfer from starting, and the native upload task receives the abort signal.
- Feedback redo IDs now retain the original text and remember choice, so changing either under the same ID returns `CONFLICT`.
  The durable dispatcher saves a remembered lesson before delivering the redo and recovers an interrupted save.
  Retrying a delivered redo does not restore a lesson the owner subsequently forgot.
- The isolated memory web stack has its own Next.js output directory, so its lock cannot conflict with an active local server.
- Background notification Review reads the native initial notification again on foreground, deduplicated by notification ID and destination.
  This fixes a reproduced case where Review returned to Home instead of opening the approval.
- Replyable notifications use Android MessagingStyle and the message category.
  On this MIUI phone, the previous generic notification action closed the shade without opening RemoteInput.
  The replacement opens Android's inline editor, sends through the background handler, and receives a real teammate reply.
- The Maestro suite handles MIUI's app chooser and Expo's developer menu, waits for approval decisions to complete, and checks streaming before the UI settles.
  Its fixtures are removed by ID, and its artifacts live outside Playwright's output directory.
  Every run has unique native notification IDs, so Android cannot carry an unsent draft from a failed test into the next run.
  The inline flow waits for the exact text, taps Android's Send control, then allows 60 seconds for a manual native Send on phones that ignore the injected tap.
  This MIUI phone required the owner to tap Send; the owner confirmed it works.

## Phone evidence

The resumed Claude conversation already exercised photo attachment upload and preview, streaming, feedback redo, inline approvals, always-allow creation and removal, offline approval state, a decision made elsewhere, group creation and mentions, rename/archive, notification read state and message search.
The completion pass independently reproduced and fixed the open approval detail staying pending after a denial elsewhere.
Background Approve and stale actions were exercised through the real notification shade and checked against database outcomes.
Background Review was reproduced before the routing fix and verified afterward.
Inline Reply was entered in Android's native RemoteInput, sent while the launcher remained the resumed activity, and verified as exactly one user message with a completed `MOBILE_INLINE_OK` teammate response.
The local purchase fixture remained pending while the native biometric prompt was open, then became approved after the owner authenticated with their fingerprint.
The app returned to the chat showing the approval outcome.
Camera launch and cancellation passed on the real phone.
Dictation entered the Listening state and stopped successfully; spoken transcription was not checked.
Light Home, chat and approval screens were inspected, and dark Home/chat checks were completed earlier in this pass and the recovered Claude session.

The combined Maestro run passed sign-in, streamed completion, in-app approval, a live denial while its detail stayed open, background Approve, the stale notification action, and background purchase Review.
Its automated inline Send did not complete on MIUI; the owner tapped Send successfully during the native check.
Do not treat this as an unattended all-green Maestro run.
The flow now waits for native input, checks the exact entered text, and allows 60 seconds for an owner Send when the injected tap is ignored.

At the owner's request, the controlled 10-minute background/unlock check and further time-consuming reruns were skipped.
File picker, spoken transcription, steer/stop and reconnect-indicator walkthroughs were not independently completed in this pass.
The automated tests cover cursor preservation, foreground invalidation, focus ownership, dictation cleanup and upload cancellation, but they do not replace the skipped real-device background test.

## Release handoff

The signed APK is generated at `android/app/build/outputs/apk/release/app-release.apk`.
Its bundle points to `https://openbot.up.railway.app` and excludes the development `e2ePush` notification hook.
The normal release excludes the phase 0 egress experiment.
The backend needs migrations `0023_pocket_inbox` and `0024_feedback_retry` and the matching web/worker rollout for all Phase 1 features to work in daily use.
Migration `0024` adds nullable feedback request metadata to messages; it is additive.
At the owner's request, the development app was uninstalled and this signed APK was installed over the existing daily app on November 3, 2026.
Production app data was preserved by installing it as an update.
Pulling the installed APK back from the phone confirmed its SHA-256 matches the built artifact.
The quick production launch reached Home but showed the explicit server-out-of-date message.
The latest app is installed; production backend rollout is required to use its new Home and other Phase 1 endpoints.

Local notification automation injects only the incoming FCM-shaped data.
It uses the actual Notifee rendering, Android notification buttons, background handler and authenticated RPC calls.
It does not establish Firebase delivery to the new release build.
Production deployment, a real FCM delivery/reply check and the final signed-app check against production remain a separate rollout step.
No commit, push, PR, merge or deployment was performed during this completion pass.
