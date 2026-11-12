import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM for secrets at rest (the OpenAI API key). The key is 32 bytes, base64 encoded. */

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return key;
}

export function encryptSecret(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(sealed: string, base64Key: string): string {
  const [iv, tag, data] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !data) throw new Error("Malformed secret");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** A safe hint of a key, like `sk-…a1b2`. */
export function secretHint(secret: string): string {
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

export const DEV_ENCRYPTION_KEY = "ZGV2LWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzLWxvbmc=";

/**
 * The development defaults for the secrets the apps share, and `.env.example`'s placeholder for
 * the sign-in library's secret. They are public (in this repository), so production refuses to
 * start with any of them.
 */
export const DEV_SECRETS = {
  WORKER_SECRET: "dev-worker-secret-change-me",
  ENCRYPTION_KEY: DEV_ENCRYPTION_KEY,
  BOTD_TOKEN: "dev-botd-token-change-me",
  PAGES_SECRET: "dev-pages-secret-change-me-0123456789",
  BETTER_AUTH_SECRET: "change-me-to-a-long-random-string",
} as const;

/** Throws in production when a secret in use is still its public development default. */
export function assertNoDevSecrets(
  inUse: Partial<Record<keyof typeof DEV_SECRETS, string>>,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== "production") return;
  const defaults = Object.entries(inUse)
    .filter(([name, value]) => value === DEV_SECRETS[name as keyof typeof DEV_SECRETS])
    .map(([name]) => name);
  if (defaults.length)
    throw new Error(
      `Set ${defaults.join(", ")} in production: the development default is public, so it protects nothing.`,
    );
}

/** The SHA-256 of a paired phone's secret, as stored: the secret itself is never kept. */
export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
