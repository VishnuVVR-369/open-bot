import type { NextConfig } from "next";

/**
 * The deploy this build belongs to. With it, Next.js reloads a tab whose code is older than the
 * server instead of navigating, and the live stream tells open tabs to reload
 * (`apps/web/src/lib/deployment.ts`).
 */
const deploymentId =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.NEXT_DEPLOYMENT_ID || undefined;

const nextConfig: NextConfig = {
  deploymentId,
  env: { OPENBOT_DEPLOYMENT_ID: deploymentId ?? "" },
  // Isolated regression stacks must not share the active development server's lock or output.
  // List a new folder's type globs in tsconfig.json's `include`, or `next dev` rewrites that file.
  distDir: process.env.OPENBOT_NEXT_DIST_DIR ?? ".next",
  transpilePackages: [
    "@open-bot/api",
    "@open-bot/db",
    "@open-bot/domain",
    "@open-bot/integrations",
    "@open-bot/memory",
  ],
  serverExternalPackages: ["pg"],
  devIndicators: false,
  async headers() {
    return [
      {
        // The service worker updates as soon as it changes, and only runs this app's scripts.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
