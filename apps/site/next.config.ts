import createMDX from "@next/mdx";
import type { NextConfig } from "next";

// The site and media URLs are baked into the static files, so a deploy build must not fall back to localhost.
if (process.env.CI || process.env.CF_PAGES) {
  for (const name of ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_MEDIA_URL"]) {
    if (!process.env[name])
      throw new Error(`${name} must be set for a deploy build (see apps/site/README.md)`);
  }
}

const nextConfig: NextConfig = {
  // A fully static site: `next build` writes it to out/ for Cloudflare.
  output: "export",
  devIndicators: false,
  // The docs are MDX pages under src/app/docs.
  pageExtensions: ["ts", "tsx", "mdx"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Plugins are named by string, so Turbopack can load them (it can't take JavaScript functions).
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: [
      "rehype-slug",
      // Code is highlighted at build time, so pages ship no highlighter.
      ["rehype-pretty-code", { theme: "github-light", keepBackground: false }],
    ],
  },
});

export default withMDX(nextConfig);
