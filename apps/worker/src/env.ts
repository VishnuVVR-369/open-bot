import os from "node:os";
import path from "node:path";
import { assertNoDevSecrets, DEV_SECRETS } from "@open-bot/domain/secrets";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://openbot:openbot@127.0.0.1:54329/openbot"),
  COMPUTER_IDLE_MINUTES: z.coerce.number().positive().max(60).default(5),
  COMPUTER_LIFECYCLE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Where botd listens. Locally the computer container publishes it on localhost. */
  BOTD_URL: z.string().default("http://127.0.0.1:7070"),
  BOTD_TOKEN: z.string().min(16).default(DEV_SECRETS.BOTD_TOKEN),
  /** Shared secret for the web server's calls to the worker and for signing VNC and egress tokens. */
  WORKER_SECRET: z.string().min(16).default(DEV_SECRETS.WORKER_SECRET),
  WORKER_PORT: z.coerce.number().default(4001),
  /** Encrypts stored credentials (the OpenAI API key). 32 bytes, base64. */
  ENCRYPTION_KEY: z.string().default(DEV_SECRETS.ENCRYPTION_KEY),
  /** Development: the Codex login on this machine, used read-only for the computer's ChatGPT session. */
  HOST_CODEX_AUTH_FILE: z.string().default(path.join(os.homedir(), ".codex", "auth.json")),
  /** Development: the Codex CLI on this machine, used to refresh that login when it gets old. */
  HOST_CODEX_BIN: z.string().default("codex"),
  /** Where you open the app. Webhook URLs start with it. */
  APP_URL: z
    .string()
    .url()
    .default(process.env.BETTER_AUTH_URL ?? "http://localhost:3000"),
  /**
   * Let watches fetch pages on private networks (this machine, the LAN). Off in production, so a
   * watch can't reach the services next to the worker.
   */
  WATCH_ALLOW_PRIVATE_URLS: z
    .enum(["true", "false"])
    .default(process.env.NODE_ENV === "production" ? "false" : "true")
    .transform((value) => value === "true"),
  /** The Telegram Bot API. Tests point it at a stand-in. */
  TELEGRAM_API_BASE_URL: z.string().url().default("https://api.telegram.org"),
  /**
   * The Firebase service account JSON (one line) the worker sends phone notifications with,
   * through Firebase Cloud Messaging. Without it, phones get no notifications.
   */
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Firebase Cloud Messaging's API. Tests point it at a stand-in. */
  FCM_API_BASE_URL: z.string().url().default("https://fcm.googleapis.com"),
  MAX_CONCURRENT_RUNS: z.coerce.number().default(4),
  /** Where API key traffic goes (the OpenAI API, or a compatible proxy). */
  OPENAI_API_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  /**
   * Testing only: send "plan" traffic to this Responses-compatible URL instead of ChatGPT,
   * so the fallback can be rehearsed against a server that reports a usage limit.
   */
  OPEN_BOT_PLAN_BASE_URL: z.string().url().optional(),
});

export const env = schema.parse(process.env);
assertNoDevSecrets(
  {
    WORKER_SECRET: env.WORKER_SECRET,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    BOTD_TOKEN: env.BOTD_TOKEN,
  },
  process.env.NODE_ENV,
);
export type Env = typeof env;
