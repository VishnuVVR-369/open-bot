"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { site } from "@/lib/site";
import { chapterEnd, chapters, formatTime, tour } from "@/lib/tour";
import { GitHubMark, PlayGlyph } from "./icons";

/** The <hls-video> element: a video element with the hls.js instance it streams through. */
type TourMedia = HTMLVideoElement & {
  api?: { startLoad: (position?: number, skipSeek?: boolean) => void } | null;
};

type TourState = {
  /** "loop" shows the silent preview; "tour" shows the player. */
  mode: "loop" | "tour";
  playing: boolean;
  ended: boolean;
  time: number;
  playFrom: (at?: number) => void;
  attach: (media: TourMedia | null) => void;
  monitorRef: React.RefObject<HTMLDivElement | null>;
};

const TourContext = createContext<TourState | null>(null);

function useTour() {
  const value = useContext(TourContext);
  if (!value) throw new Error("useTour must be used inside <TourProvider>");
  return value;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"loop" | "tour">("loop");
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const mediaRef = useRef<TourMedia | null>(null);
  const pendingRef = useRef<number | null>(null);
  const monitorRef = useRef<HTMLDivElement | null>(null);

  const start = useCallback((media: TourMedia, at: number) => {
    const api = media.api;
    if (media.readyState === 0 && api && at > 0) {
      // On the first play, hls-video-element starts the stream from the beginning. Point that start at the
      // chapter instead, so the opening isn't downloaded before the seek.
      const startLoad = api.startLoad;
      api.startLoad = (position = -1, skipSeek) => {
        api.startLoad = startLoad;
        startLoad.call(api, position === -1 ? at : position, skipSeek);
      };
    }
    if (Math.abs(media.currentTime - at) > 0.25 || media.ended) media.currentTime = at;
    // Called inside the click, so the browser lets the tour play with sound.
    // If it still refuses, the player's own play button stays up.
    media.play()?.catch(() => {});
  }, []);

  const playFrom = useCallback(
    (at = 0) => {
      setMode("tour");
      setEnded(false);
      const media = mediaRef.current;
      if (media) start(media, at);
      else pendingRef.current = at;
    },
    [start],
  );

  const attach = useCallback(
    (media: TourMedia | null) => {
      mediaRef.current = media;
      if (!media) return;
      const sync = () => {
        setPlaying(!media.paused);
        setEnded(media.ended);
        setTime(media.currentTime);
      };
      // Captions come on whenever the sound goes off, so a muted tour still makes sense.
      const captionsWhenMuted = () => {
        if (!media.muted) return;
        const captions = Array.from(media.textTracks).find((t) => t.kind === "captions");
        if (captions && captions.mode !== "showing") captions.mode = "showing";
      };
      for (const event of ["play", "pause", "ended", "timeupdate", "seeked"]) {
        media.addEventListener(event, sync);
      }
      media.addEventListener("volumechange", captionsWhenMuted);
      if (pendingRef.current !== null) {
        start(media, pendingRef.current);
        pendingRef.current = null;
      }
    },
    [start],
  );

  const value = useMemo(
    () => ({ mode, playing, ended, time, playFrom, attach, monitorRef }),
    [mode, playing, ended, time, playFrom, attach],
  );
  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

function usePrefersStill() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData;
    const update = () => setStill(query.matches || Boolean(saveData));
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return still;
}

/** The player loads after the page settles. It fetches only the playlist until someone presses play. */
function useTourPlayer() {
  const [Player, setPlayer] = useState<typeof import("./tour-player").default | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      import("./tour-player").then((mod) => {
        if (!cancelled) setPlayer(() => mod.default);
      });
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 200));
    const handle = idle(load);
    return () => {
      cancelled = true;
      window.cancelIdleCallback?.(handle as number);
    };
  }, []);
  return Player;
}

function HeroLoop() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const still = usePrefersStill();
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || still) return;
    // Plays only while it is on screen.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, [still]);

  return (
    <div aria-hidden className="absolute inset-0">
      <picture>
        <source srcSet="/media/hero-poster.avif" type="image/avif" />
        <img
          src="/media/hero-poster.jpg"
          alt=""
          width={1920}
          height={1080}
          fetchPriority="high"
          className="absolute inset-0 size-full object-cover"
        />
      </picture>
      {!still && (
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          preload="none"
          disablePictureInPicture
          disableRemotePlayback
          onPlaying={() => setShowing(true)}
          className="absolute inset-0 size-full object-cover transition-opacity duration-500"
          style={{ opacity: showing ? 1 : 0 }}
        >
          <source src="/media/hero-loop.av1.mp4" type='video/mp4; codecs="av01.0.08M.08"' />
          <source src="/media/hero-loop.h264.mp4" type="video/mp4" />
        </video>
      )}
    </div>
  );
}

export function Monitor() {
  const { mode, playing, ended, playFrom, attach, monitorRef } = useTour();
  const Player = useTourPlayer();
  const tally = mode === "loop" ? "live" : playing ? "on" : "off";

  return (
    <div ref={monitorRef} id="tour" className="scroll-mt-6">
      <div className="relative rounded-[22px] bg-bezel p-2 shadow-[0_1px_0_rgb(255_255_255/0.06)_inset] sm:rounded-[30px] sm:p-3.5">
        <span
          data-state={tally}
          aria-hidden
          className="tally absolute top-[3px] right-6 size-[5px] rounded-full sm:top-[5px] sm:right-10 sm:size-[7px]"
        />
        <div className="relative aspect-video overflow-hidden rounded-[14px] bg-black sm:rounded-[18px]">
          {Player && (
            <div className="absolute inset-0" inert={mode === "loop"}>
              <Player onMedia={attach} />
            </div>
          )}

          {mode === "loop" && (
            <>
              <HeroLoop />
              <button
                type="button"
                onClick={() => playFrom(0)}
                className="group absolute inset-0 grid cursor-pointer place-items-center bg-[radial-gradient(ellipse_at_center,rgb(16_17_23/0.28),rgb(16_17_23/0.05)_70%)] focus-visible:outline-offset-[-6px]"
                aria-label={`Play the open-bot tour, ${formatTime(tour.duration)}, with sound`}
              >
                <span className="flex items-center gap-3 rounded-full bg-ink/90 py-3 pr-6 pl-3 text-white shadow-[0_10px_40px_rgb(0_0_0/0.35)] ring-1 ring-white/10 backdrop-blur transition-transform duration-200 group-hover:scale-[1.03] group-active:scale-[0.98] sm:py-4 sm:pr-8 sm:pl-4">
                  <span className="grid size-10 place-items-center rounded-full bg-live sm:size-12">
                    <PlayGlyph className="ml-0.5 size-4 sm:size-5" />
                  </span>
                  <span className="text-left leading-tight">
                    <span className="block font-display text-lg font-semibold sm:text-xl">
                      Play the tour
                    </span>
                    <span className="block text-sm text-white/70 tabular-nums">
                      {formatTime(tour.duration)} with sound
                    </span>
                  </span>
                </span>
              </button>
            </>
          )}

          {mode === "tour" && ended && (
            <div className="absolute inset-0 grid place-items-center bg-bezel/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-5 px-6 text-center text-white">
                <p className="font-display text-2xl font-semibold sm:text-4xl">
                  That&rsquo;s open-bot
                  <span className="dot" />
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <a
                    href={site.github}
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 font-medium text-ink transition-colors hover:bg-white/90"
                  >
                    <GitHubMark className="size-[18px]" />
                    View on GitHub
                  </a>
                  <button
                    type="button"
                    onClick={() => playFrom(0)}
                    className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full px-5 font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/10"
                  >
                    Watch again
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* The stand, as on the logo. */}
      <div aria-hidden className="mx-auto mt-3 h-2 w-[22%] rounded-full bg-ink sm:mt-5 sm:h-2.5" />
    </div>
  );
}

const railLabels: Record<string, string> = {
  intro: "Intro",
  job: "Jobs",
  watch: "Live screens",
  takeover: "Take over",
  approval: "Approvals",
  swarm: "Helpers",
  more: "And more",
};

/** The tour's chapters as a timeline: each one as wide as it is long. */
export function ChapterRail() {
  const { mode, time, playFrom } = useTour();
  return (
    <nav aria-label="Tour chapters" className="mt-8">
      <ol className="grid grid-cols-2 gap-x-4 gap-y-4 sm:flex sm:gap-1.5">
        {chapters.map((chapter, i) => {
          const end = chapterEnd(i);
          const length = end - chapter.at;
          const progress =
            mode === "tour" ? Math.min(1, Math.max(0, (time - chapter.at) / length)) : 0;
          const current = mode === "tour" && time >= chapter.at && time < end;
          return (
            <li
              key={chapter.id}
              style={{ "--length": length } as React.CSSProperties}
              className="sm:min-w-0 sm:flex-[var(--length)_1_0%]"
            >
              <button
                type="button"
                onClick={() => playFrom(chapter.at)}
                aria-current={current ? "step" : undefined}
                aria-label={`Play from ${formatTime(chapter.at)}: ${chapter.title}`}
                className="group block w-full cursor-pointer pt-1 text-left"
              >
                <span className="relative block h-1 overflow-hidden rounded-full bg-rule transition-colors group-hover:bg-graphite/40">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-live"
                    style={{ width: `${progress * 100}%` }}
                  />
                </span>
                <span className="mt-2.5 flex items-baseline gap-2 text-sm">
                  <span className="text-graphite tabular-nums">{formatTime(chapter.at)}</span>
                  <span
                    className={`truncate font-medium ${current ? "text-ink" : "text-ink/80 group-hover:text-ink"}`}
                  >
                    {railLabels[chapter.id]}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Plays one chapter of the tour on the monitor. */
export function PlayChapter({ id }: { id: string }) {
  const { playFrom, monitorRef } = useTour();
  const index = chapters.findIndex((c) => c.id === id);
  const chapter = chapters[index];
  return (
    <button
      type="button"
      onClick={() => {
        playFrom(chapter.at);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        monitorRef.current?.scrollIntoView({
          behavior: reduce ? "auto" : "smooth",
          block: "center",
        });
      }}
      className="group inline-flex cursor-pointer items-center gap-3 rounded-full py-1 pr-1 text-left"
    >
      <span className="grid size-9 place-items-center rounded-full bg-ink text-white transition-transform group-hover:scale-105 group-active:scale-95">
        <PlayGlyph className="ml-0.5 size-3.5" />
      </span>
      <span className="leading-tight">
        <span className="block font-medium">Play this part</span>
        <span className="block text-sm text-graphite tabular-nums">
          {formatTime(chapter.at)} to {formatTime(chapterEnd(index))}
        </span>
      </span>
    </button>
  );
}
