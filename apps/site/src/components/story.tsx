"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Heading } from "./heading";
import { PlayChapter } from "./tour";

/** The screen's state, shown the way the app shows it: red is live, amber is "you have control". */
export type Signal = "off" | "live" | "manual";

export type StoryChapter = {
  id: string;
  title: string;
  body: ReactNode;
  signal: Signal;
  /** What the screen shows, in the words of the app's own status line. */
  status: string;
  /** A screenshot of the app. The screen crops it to the work, leaving out the app's sidebar. */
  shot: { name: string; alt: string };
};

function Shot({ shot, active = true }: { shot: StoryChapter["shot"]; active?: boolean }) {
  const { name, alt } = shot;
  return (
    <picture
      className="absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none"
      style={{ opacity: active ? 1 : 0 }}
    >
      <source
        type="image/avif"
        srcSet={`/media/shots/${name}-1280.avif 1280w, /media/shots/${name}-2240.avif 2240w`}
        sizes="(min-width: 1024px) 960px, 100vw"
      />
      <img
        src={`/media/shots/${name}-1280.webp`}
        alt={active ? alt : ""}
        width={2880}
        height={1800}
        loading="lazy"
        decoding="async"
        className="block size-full object-cover object-right"
      />
    </picture>
  );
}

/** A small monitor like the one in the hero: a bezel, a tally light and the app's status line under it. */
function Screen({
  chapters,
  active,
  className = "",
}: {
  chapters: StoryChapter[];
  active: string;
  className?: string;
}) {
  const current = chapters.find((c) => c.id === active) ?? chapters[0];
  return (
    <figure className={className}>
      <div className="relative rounded-[20px] bg-bezel p-2 shadow-[0_1px_0_rgb(255_255_255/0.06)_inset] sm:rounded-[24px] sm:p-2.5">
        <span
          data-state={current.signal}
          aria-hidden
          className="signal signal-glow absolute top-[2.5px] right-6 size-[5px] rounded-full sm:right-8 sm:size-[6px]"
        />
        <div className="relative aspect-[13/10] overflow-hidden rounded-[13px] bg-sheet sm:rounded-[15px]">
          {chapters.map((chapter) => (
            <Shot key={chapter.id} shot={chapter.shot} active={chapter.id === current.id} />
          ))}
        </div>
      </div>
      <figcaption className="mt-4 flex items-center gap-2.5 text-[0.9375rem] text-graphite">
        <span
          data-state={current.signal}
          aria-hidden
          className="signal size-2 shrink-0 rounded-full"
        />
        <span>{current.status}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The chapters of the tour as a story: the text scrolls while the screen beside it stays put and
 * shows the moment each chapter describes. On narrow screens each chapter carries its own screen.
 */
export function Story({ chapters }: { chapters: StoryChapter[] }) {
  const [active, setActive] = useState(chapters[0].id);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sections = listRef.current?.querySelectorAll<HTMLElement>(":scope > section");
    if (!sections) return;
    // The chapter crossing the middle of the viewport is the one on screen.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
      },
      { rootMargin: "-50% 0px -50% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-14 xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] xl:gap-x-20">
      <div ref={listRef}>
        {chapters.map((chapter) => (
          <section
            key={chapter.id}
            id={chapter.id}
            aria-labelledby={`${chapter.id}-title`}
            data-active={chapter.id === active}
            className="story-chapter scroll-mt-10 py-14 sm:py-20 lg:flex lg:min-h-[76svh] lg:flex-col lg:justify-center lg:py-0"
          >
            <div id={`${chapter.id}-title`}>
              <Heading size="chapter">{chapter.title}</Heading>
            </div>
            <p className="mt-5 max-w-[34rem] text-lg text-graphite">{chapter.body}</p>
            <div className="mt-7">
              <PlayChapter id={chapter.id} />
            </div>
            <Screen chapters={[chapter]} active={chapter.id} className="mt-10 lg:hidden" />
          </section>
        ))}
      </div>
      <div className="hidden lg:block">
        <div className="sticky top-0 flex h-svh items-center">
          <Screen
            chapters={chapters}
            active={active}
            className="mx-auto w-full max-w-[calc((100svh-9rem)*1.3)]"
          />
        </div>
      </div>
    </div>
  );
}
