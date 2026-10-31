# open-bot landing page

The public page for open-bot: a static Next.js site built around the launch tour.
It is separate from `apps/web`, which is the private app behind your login.

- `src/app/page.tsx` is the page.
  Each section is a chapter of the tour, and its play button plays that chapter on the monitor.
- `src/components/tour.tsx` holds the monitor, the silent hero loop, the chapter rail and the playback state.
- `src/components/tour-player.tsx` is the player: media-chrome controls on an adaptive HLS stream through hls.js.
  It loads after the page settles and fetches nothing until someone presses play.
- `src/lib/tour.ts` lists the chapters.
  The player's chapter track (`/media/tour-chapters.vtt`) is generated from the same list.
- `public/media/` holds the small files served with the site: the hero loop, its poster, captions, scrub thumbnails and screenshots.
- The tour stream itself is too big for the site host, so it lives in a Cloudflare R2 bucket.

## The documentation

The technical documentation lives under `/docs`, as MDX pages in `src/app/docs/**/page.mdx`.

- `src/lib/docs.ts` lists every page in reading order, with its title and description.
  The sidebar, previous and next links, page metadata and the sitemap all come from that list.
- `src/app/docs/layout.tsx` is the frame: the header, the sidebar, the menu on phones and "On this page".
- `src/mdx-components.tsx` maps Markdown to components, and makes the diagram components available in every page without imports.
- `src/components/docs/diagrams.tsx` holds the architecture and state diagrams, drawn as SVG with the helpers in `svg.tsx`.
  They are laid out for the 744px article column, so their text renders at its real size on desktop, and they scroll sideways on phones.
- `src/components/docs/sequence.tsx` draws sequence diagrams from data, in HTML, so their labels wrap like normal text.
- Code blocks are highlighted at build time by `rehype-pretty-code`, so pages ship no highlighter.

To add a page, add its entry to `src/lib/docs.ts`, then create `src/app/docs/<path>/page.mdx` starting with:

```mdx
import { docMetadata } from "@/lib/docs";

export const metadata = docMetadata("/docs/<path>");

# Title
```

`e2e/docs.spec.ts` loads every page in every browser, and checks that every link between pages lands on a page and a heading that exist.

## Run it locally

```sh
pnpm --filter @open-bot/site media:encode   # once: builds .media/ and public/media/ from the video project
pnpm --filter @open-bot/site media:serve    # the stream on http://localhost:3201, standing in for R2
pnpm --filter @open-bot/site dev            # the site on http://localhost:3200
```

`media:encode` reads the launch video project at `~/Desktop/Coding/Projects/open-bot-video`, or the path you pass it.
It needs ffmpeg (with libx264 and libsvtav1), avifenc and cwebp.

## Test it

```sh
pnpm --filter @open-bot/site test:e2e
```

The tests build the site and serve it the way it is deployed: the site on one origin, the stream on another, with the production headers.
They run in Google Chrome (Playwright's own Chromium can't play H.264), WebKit and a mobile Chrome profile.
Install WebKit once with `pnpm exec playwright install webkit`.

## Deploy

Everything runs on free Cloudflare URLs: the stream on an `r2.dev` address and the site on `workers.dev`.

### 1. The stream on R2

1. In the Cloudflare dashboard, create an R2 bucket, for example `open-bot-media`.
2. Under the bucket's **Settings**, enable the **Public Development URL** and note it (`https://pub-….r2.dev`).
3. Under **Settings → CORS policy**, allow the site to read the stream:

   ```json
   [
     {
       "AllowedOrigins": ["https://open-bot.<your-subdomain>.workers.dev", "http://localhost:3200"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Length", "Content-Range"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   Use the site's real address, which the Worker shows after its first deploy.

4. Upload the encoded tour with its content types and caching:

   ```sh
   npx wrangler login
   apps/site/scripts/upload-media.sh open-bot-media
   ```

### 2. The site on Cloudflare Workers

The site deploys as a Worker that only serves static files, configured in `wrangler.jsonc`.
Create a Worker connected to the GitHub repository (**Workers & Pages → Create → Import a repository**) with these settings:

| Setting                              | Value                                          |
| ------------------------------------ | ---------------------------------------------- |
| Root directory                       | `/`                                            |
| Build command                        | `pnpm --filter @open-bot/site build`           |
| Deploy command                       | `npx wrangler deploy --cwd apps/site`          |
| Non-production branch deploy command | `npx wrangler versions upload --cwd apps/site` |

Under **Settings → Build → Variables and secrets**, add these build variables:

| Variable                        | Value                                                  |
| ------------------------------- | ------------------------------------------------------ |
| `NODE_VERSION`                  | `24`                                                   |
| `NEXT_PUBLIC_SITE_URL`          | `https://open-bot.<your-subdomain>.workers.dev`        |
| `NEXT_PUBLIC_MEDIA_URL`         | the bucket's `https://pub-….r2.dev` URL                |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | `1` (the site doesn't need the desktop app's Electron) |

They are build variables, not runtime ones: the URLs are baked into the static files.
A build on Cloudflare stops with an error if either URL is missing, so a deploy never points at localhost.
Every push to `main` deploys, and other branches get a preview version.

To deploy from your own machine instead, build with both variables set and deploy:

```sh
NEXT_PUBLIC_SITE_URL=https://open-bot.<your-subdomain>.workers.dev NEXT_PUBLIC_MEDIA_URL=https://pub-….r2.dev \
  pnpm --filter @open-bot/site build
npx wrangler deploy --cwd apps/site
```

`next build` also writes `out/_headers`: the content security policy (which allows the media URL), security headers and caching rules.
Cloudflare applies it, and serves `out/404.html` for unknown paths.

### Moving to your own domain later

The `r2.dev` address is rate limited and not cached by Cloudflare's CDN, so it is fine for now but not for heavy traffic.
When you have a domain:

1. Add the domain to Cloudflare, then connect `media.<domain>` to the bucket under **Settings → Custom Domains**.
2. Add a Cache Rule for `media.<domain>` that makes everything eligible for cache: Cloudflare doesn't cache `.m3u8` and `.m4s` by default.
3. Add `<domain>` as a custom domain of the Worker, under **Settings → Domains & Routes**.
4. Update the CORS policy's `AllowedOrigins`, then `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_MEDIA_URL`, and redeploy.

## A new cut of the video

Files under `tour/v1` never change once published, and they are cached for a year.
For a new cut, encode into `tour/v2` (change the folder in `scripts/encode-media.sh` and `version` in `src/lib/tour.ts`), upload it, and deploy.
