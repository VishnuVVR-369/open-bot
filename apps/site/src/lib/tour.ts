/** The launch tour: where its files live and the chapters the page is built around. */

/** Base URL of the media bucket. Files under a version never change, so a new cut gets a new version. */
const mediaUrl = (process.env.NEXT_PUBLIC_MEDIA_URL ?? "http://localhost:3201").replace(/\/$/, "");
const version = "v1";

export const tour = {
  stream: `${mediaUrl}/tour/${version}/master.m3u8`,
  download: `${mediaUrl}/tour/${version}/open-bot-tour.mp4`,
  mediaOrigin: new URL(mediaUrl).origin,
  captions: "/media/tour-captions.vtt",
  thumbnails: "/media/tour-thumbs.vtt",
  duration: 86,
} as const;

export type Chapter = {
  id: string;
  /** Where the chapter starts in the tour, in seconds. */
  at: number;
  title: string;
};

export const chapters: Chapter[] = [
  { id: "intro", at: 0, title: "Meet open-bot" },
  { id: "job", at: 14, title: "Give them a job" },
  { id: "watch", at: 24, title: "Watch them work" },
  { id: "takeover", at: 38, title: "Take the wheel" },
  { id: "approval", at: 46, title: "Nothing ships without your OK" },
  { id: "swarm", at: 56, title: "Many hands at once" },
  { id: "more", at: 64, title: "And the rest" },
];

export function chapterEnd(index: number) {
  return chapters[index + 1]?.at ?? tour.duration;
}

export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
