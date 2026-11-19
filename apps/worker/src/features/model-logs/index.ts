// Model logs: the model proxy Codex's requests go through, over HTTP or WebSockets, which forwards
// them unchanged, adds the API key for live runs, and saves each request in batches; the tap that
// saves the Codex app-server stream and each run's turns; and the memory AI's request observer.
// Code outside this folder imports only from here.
export type { ModelRequestRecord } from "./capture";
export { CodexEventTap, type TapRuns } from "./codex-events";
export { modelLogsFeature } from "./feature";
export { memoryRequestObserver } from "./memory";
export { ModelProxy, PLAN_PREFIX, type ProxyRuns, REHEARSAL_TOKEN } from "./proxy";
export {
  MODEL_PROXY_PATH,
  type ModelProxyEnv,
  modelProxyToken,
  modelProxyUrl,
  workerUrlFromComputer,
} from "./routing";
export { modelLogSettler, SETTLE_MS } from "./settle";
export { ModelLogRetention, type RetentionOptions, type SweepResult } from "./retention";
export { ModelLogWriter, type UnsavedApiSpend } from "./writer";
