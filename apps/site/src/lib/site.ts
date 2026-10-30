export const site = {
  name: "open-bot",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3200").replace(/\/$/, ""),
  title: "open-bot: your AI teammates and the computer they share",
  description:
    "Open-source AI teammates with jobs. They work on one real computer with a browser, a shell and files, while you watch live, take over at any time and approve anything risky.",
  github: "https://github.com/VishnuVVR-369/open-bot",
} as const;
