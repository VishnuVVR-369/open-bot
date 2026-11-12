/**
 * The site's settings, and the only place it reads the environment. Next.js inlines each
 * `NEXT_PUBLIC_*` variable at build time, so each is read by its literal name.
 */
export const site = {
  name: "open-bot",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3200").replace(/\/$/, ""),
  /** Base URL of the media bucket that holds the tour. */
  mediaUrl: (process.env.NEXT_PUBLIC_MEDIA_URL ?? "http://localhost:3201").replace(/\/$/, ""),
  title: "open-bot: your AI teammates and the computer they share",
  description:
    "Open-source AI teammates with jobs. They work on one real computer with a browser, a shell and files, while you watch live, take over at any time and approve anything risky.",
  github: "https://github.com/VishnuVVR-369/open-bot",
} as const;
