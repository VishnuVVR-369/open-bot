import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolated regression stacks must not share the active development server's lock or output.
  distDir: process.env.OPENBOT_NEXT_DIST_DIR ?? ".next",
  transpilePackages: [
    "@open-bot/accounts",
    "@open-bot/api",
    "@open-bot/db",
    "@open-bot/shared",
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
  experimental: {
    // Attachments and uploads go through Server Actions, up to 40 MB plus the multipart overhead.
    serverActions: { bodySizeLimit: "41mb" },
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
