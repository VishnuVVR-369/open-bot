/**
 * The stack the end-to-end specs run against, and the names they give what they create.
 *
 * The specs write to the stack's database and computer directly, and the teardown deletes from
 * them, so nothing here falls back to a default: a run with its app pointed at a throwaway stack
 * must never clean up the development one instead. Either name every part of the stack, or set
 * `E2E_STACK=dev` to mean the local development stack (`pnpm infra:up` and `pnpm dev`).
 */
import { randomUUID } from "node:crypto";

export interface E2eStack {
  /** The web app. */
  baseUrl: string;
  databaseUrl: string;
  workerUrl: string;
  botdUrl: string;
}

const PARTS = {
  baseUrl: "E2E_BASE_URL",
  databaseUrl: "DATABASE_URL",
  workerUrl: "WORKER_URL",
  botdUrl: "BOTD_URL",
} as const satisfies Record<keyof E2eStack, string>;

const DEV_STACK: E2eStack = {
  baseUrl: "http://localhost:3000",
  databaseUrl: "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  workerUrl: "http://127.0.0.1:4001",
  botdUrl: "http://127.0.0.1:7070",
};

/** The stack from `env`, or an error that says what to set. */
export function readStack(env: Record<string, string | undefined>): E2eStack {
  const given = Object.entries(PARTS).filter(([, name]) => env[name]);
  if (env.E2E_STACK === "dev") {
    // Mixing the two is how a run cleans up a stack it didn't test.
    if (given.length)
      throw new Error(
        `E2E_STACK=dev names the whole development stack, so leave ${given.map(([, name]) => name).join(", ")} unset.`,
      );
    return DEV_STACK;
  }
  if (env.E2E_STACK) throw new Error(`E2E_STACK can only be "dev", not "${env.E2E_STACK}".`);
  const missing = Object.values(PARTS).filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      `The end-to-end tests write to the stack they test, so they need it named: set ${missing.join(", ")}, ` +
        "or E2E_STACK=dev for the local development stack.",
    );
  const stack = Object.fromEntries(
    Object.entries(PARTS).map(([key, name]) => [key, env[name]!]),
  ) as unknown as E2eStack;
  for (const [key, name] of Object.entries(PARTS))
    checkUrl(name, stack[key as keyof E2eStack], key === "databaseUrl");
  return stack;
}

/**
 * Refuses a URL that leaves part of its target to defaults: the Postgres driver fills in a missing
 * host or database from PGHOST, PGDATABASE or its own defaults, which is a database nobody named.
 */
function checkUrl(name: string, value: string, database: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} isn't a URL: set it to the full address of the stack's part.`);
  }
  if (database) {
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2
    )
      throw new Error(
        `${name} must name the host and the database, like postgres://user@host:5432/db.`,
      );
  } else if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
    throw new Error(`${name} must be an http(s) URL with a host.`);
}

let stack: E2eStack | undefined;

/** The stack under test, read once. `playwright.config.ts` checks it before any test runs. */
export function e2eStack(): E2eStack {
  stack ??= readStack(process.env);
  return stack;
}

/** The environment variable that holds this run's tag, which global setup makes. */
export const RUN_TAG = "E2E_RUN_TAG";

/**
 * A new run tag: 8 random hex digits, so two runs, or a run and what an interrupted one left
 * behind, practically never share one.
 */
export function newRunTag() {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

/**
 * This run's tag. Everything a spec creates carries it, and teardown deletes only what does, so
 * nothing of yours, and nothing another run made at the same time, can match.
 */
export function runTag(env: Record<string, string | undefined> = process.env): string {
  const tag = env[RUN_TAG];
  if (!tag || !/^[0-9a-f]{8}$/.test(tag))
    throw new Error(
      `${RUN_TAG} isn't set: the end-to-end tests run through Playwright's global setup.`,
    );
  return tag;
}

/** The names `uniqueName()` gives teammates in the run tagged `tag`, and the " 2" a duplicate gets. */
export function testTeammateName(tag: string) {
  return new RegExp(`^E2e${tag}[A-Z][a-z]+[a-z0-9]{4}( \\d+)?$`);
}

/** `prefix` and 4 random letters or digits, such as `allergy4kq9`, for text a test looks for. */
export function uniqueWord(prefix: string) {
  return `${prefix}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/**
 * A teammate name for a test, such as `E2e3f9c07a1Tess4kq9`: `E2e`, the run's tag, `prefix` (a
 * capitalized word) and 4 random letters or digits. Only for teammates: the teardown deletes every
 * teammate this run named like this.
 */
export function uniqueName(prefix: string) {
  if (!/^[A-Z][a-z]+$/.test(prefix)) throw new Error(`Use a capitalized word, not "${prefix}".`);
  return `E2e${runTag()}${uniqueWord(prefix)}`;
}

/**
 * A title or label for something a test creates, such as `E2E GitHub 3f9c07a1`, which the teardown
 * deletes (`TEST_LABEL`). `words` is what the test calls it.
 */
export function testLabel(words: string) {
  return `E2E ${words} ${runTag()}`;
}

/**
 * A lowercase name for a skill or a file a test creates, such as `e2e-3f9c07a1-x9f3a`, which the
 * teardown deletes (`TEST_SLUG`). `words` is what the test calls it.
 */
export function testSlug(words: string) {
  return `e2e-${runTag()}-${words}`;
}

/** SQL `like` patterns for `testLabel()` and `testSlug()` in the run tagged `tag`. */
export const TEST_LABEL = (tag: string) => `E2E % ${tag}`;
export const TEST_SLUG = (tag: string) => `e2e-${tag}-%`;

/**
 * An OpenAI API key for a spec to save, ending in the run's tag, and the hint the app shows for it
 * (`sk-…` and its last 4 characters), which tells it from yours.
 */
export function testApiKey() {
  const tag = runTag();
  return { key: `sk-not-a-real-key-for-open-bot-tests-${tag}`, hint: `sk-…${tag.slice(-4)}` };
}
