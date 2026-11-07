---
name: openbot-computer
description: Use when changing apps/botd (the computer), its Chromium browser, computer sleep and wake, phone egress, sockets, queues, or any async lifecycle code in open-bot.
---

# open-bot computer and async code

## Railway is stricter than local

- Local docker is more permissive (seccomp, user namespaces). On Railway, Chromium's sandbox fails, so botd probes it and falls back to `--no-sandbox`.
- A fix that works locally is not done until checked under Railway constraints or on Railway.
- Keep the computer's `/home` volume, browser profiles, and logins intact.

## Sleep

- Railway sleeps the computer when it's idle. Reading its status must not wake it, and the worker must not keep permanent connections open.
- Failed or cancelled work must not count as activity that blocks sleep.

## Async checklist

For every change, test:

- cancellation, including queued work
- late callbacks after shutdown
- stale messages arriving after a reconnect
- explicit readiness on both ends of a socket
- state being saved during shutdown

Sync tests on observable events, never sleeps. A flaky test here is usually a real race; find it before rerunning.
