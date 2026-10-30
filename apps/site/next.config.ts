import type { NextConfig } from "next";

// The site and media URLs are baked into the static files, so a deploy build must not fall back to localhost.
if (process.env.CI || process.env.CF_PAGES) {
  for (const name of ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_MEDIA_URL"]) {
    if (!process.env[name])
      throw new Error(`${name} must be set for a deploy build (see apps/site/README.md)`);
  }
}

const nextConfig: NextConfig = {
  // A fully static site: `next build` writes it to out/ for Cloudflare Pages.
  output: "export",
  devIndicators: false,
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
