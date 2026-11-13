import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDevSecrets, DEV_SECRETS, parseEnv, unsetIfEmpty } from "@open-bot/domain/server";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().default("postgres://openbot:openbot@127.0.0.1:54329/openbot"),
  PORT: unsetIfEmpty(z.coerce.number().int().min(1).max(65535)),
  /** Shared with the web app. Production refuses the public development default. */
  PAGES_SECRET: z.string().optional(),
  /** This service's own address. Defaults to Railway's public domain, or the local one. */
  PAGES_URL: unsetIfEmpty(z.string().url()),
  RAILWAY_PUBLIC_DOMAIN: unsetIfEmpty(z.string()),
  /** The app's origins, comma-separated: the only ones that may frame a page. */
  APP_URL: z.string().default("http://localhost:3000"),
  /** Where `/lib` is served from. Defaults to next to the built server, or the page kit's build. */
  PAGE_LIB_DIR: unsetIfEmpty(z.string()),
});

export interface PagesEnv {
  databaseUrl: string;
  port: number;
  secret: string;
  /** This service's own origin, which page links and `/lib` addresses use. */
  origin: string;
  /** The app's origins, the only ones that may show a page in a frame. */
  appOrigins: string[];
  libDir: string;
}

/**
 * The pages service's settings, the only place it reads the environment. Throws a readable
 * message when one is missing or invalid.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): PagesEnv {
  const env = parseEnv(schema, source);
  const port = env.PORT ?? 3400;

  const secret = env.PAGES_SECRET ?? DEV_SECRETS.PAGES_SECRET;
  assertNoDevSecrets({ PAGES_SECRET: secret }, env.NODE_ENV);
  if (secret.length < 32)
    throw new Error(
      "PAGES_SECRET must be set to at least 32 characters (the same value as the web app's)",
    );

  // The bundle carries its own copy in dist/lib; run from source, it's page-kit's build.
  const libDir =
    env.PAGE_LIB_DIR ??
    [fileURLToPath(new URL("./lib", import.meta.url)), pageKitLibDir()].find(
      (path) => path !== null && existsSync(path),
    );
  if (!libDir)
    throw new Error("The page kit isn't built: run pnpm --filter @open-bot/page-kit build");

  return {
    databaseUrl: env.DATABASE_URL,
    port,
    secret,
    origin:
      env.PAGES_URL?.replace(/\/+$/, "") ??
      (env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
        : `http://127.0.0.1:${port}`),
    appOrigins: env.APP_URL.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin),
    libDir,
  };
}

/** Where page-kit's built libraries are, or null when page-kit isn't built (or isn't installed). */
function pageKitLibDir(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve("@open-bot/page-kit/lib/runtime.js"));
  } catch {
    return null;
  }
}
