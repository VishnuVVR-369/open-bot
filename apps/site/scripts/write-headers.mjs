// Writes out/_headers for Cloudflare Pages after `next build`: security headers, a content security policy
// that allows the media bucket, and caching. A static export can't set headers itself.
import { writeFile } from "node:fs/promises";

const media = new URL(process.env.NEXT_PUBLIC_MEDIA_URL ?? "http://localhost:3201").origin;

const csp = [
  "default-src 'self'",
  // Next.js inlines its page data as scripts, and media-chrome styles its controls with inline styles.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // hls.js streams through a blob: URL and parses segments in a blob: worker.
  `media-src 'self' blob: ${media}`,
  `connect-src 'self' ${media}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const headers = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable

/media/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
`;

await writeFile(new URL("../out/_headers", import.meta.url), headers);
console.log(`Wrote out/_headers (media from ${media})`);
