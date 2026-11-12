/**
 * The Postgres NOTIFY channels the web app, the worker and the memory jobs talk on.
 * - `chat`: the payload is a chat id; something in that chat changed (events, messages, runs).
 * - `app`: the payload is a JSON `AppEvent`; something app-wide changed.
 * - `worker`: the payload is a `WorkerSignal`; it wakes the worker.
 */
export const NOTIFY_CHANNELS = {
  chat: "openbot_chat",
  app: "openbot_app",
  worker: "openbot_worker",
} as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[keyof typeof NOTIFY_CHANNELS];

/** What wakes the worker on the `worker` channel. The worker's listener handles every one. */
export const WORKER_SIGNALS = ["runs", "schedules", "triggers", "cancel", "accounts"] as const;
export type WorkerSignal = (typeof WORKER_SIGNALS)[number];

export function isWorkerSignal(payload: string): payload is WorkerSignal {
  return (WORKER_SIGNALS as readonly string[]).includes(payload);
}
