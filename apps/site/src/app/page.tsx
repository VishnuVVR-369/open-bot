import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { GitHubMark, Logo } from "@/components/icons";
import { ChapterRail, Monitor, PlayChapter, TourProvider } from "@/components/tour";
import { site } from "@/lib/site";
import { tour } from "@/lib/tour";

const quickstart = `git clone ${site.github}.git
cd open-bot
pnpm install
cp .env.example .env    # set OWNER_EMAIL to your email
pnpm infra:up           # Postgres and the computer
pnpm db:migrate
pnpm dev                # open http://localhost:3000`;

const more = [
  {
    term: "Works while you sleep",
    detail:
      "Routines, reminders and page watches run on a schedule, with your laptop closed. Each run reports how it went.",
  },
  {
    term: "Remembers what you like",
    detail:
      "Facts and preferences every teammate can recall. Search, correct, pin or forget any of them.",
  },
  {
    term: "Never sees your passwords",
    detail:
      "Logins and cards live in a vault. Teammates fill them in on the computer without reading them.",
  },
  {
    term: "Stays inside a budget",
    detail:
      "Each teammate spends only within a monthly budget you set. Bigger purchases ask you first.",
  },
  {
    term: "Skills",
    detail:
      "Save the steps for a task once, then run it with /name in any chat. Teammates save skills too.",
  },
  {
    term: "Reaches you anywhere",
    detail:
      "Approve from Telegram, get push notifications, and give every teammate an email address on your domain.",
  },
  {
    term: "Connections",
    detail:
      "Give teammates GitHub, Notion or your own API through MCP, so they use tools instead of websites.",
  },
  {
    term: "Replay",
    detail: "Step through what a teammate did on its screen, frame by frame.",
  },
];

function Heading({ children, as: Tag = "h2" }: { children: ReactNode; as?: "h1" | "h2" }) {
  return (
    <Tag
      className={
        Tag === "h1"
          ? "font-display text-[clamp(2.75rem,7.4vw,5.75rem)] leading-[0.96] font-semibold tracking-[-0.035em] text-balance"
          : "font-display text-[clamp(2.125rem,4.6vw,3.5rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance"
      }
    >
      {children}
      <span className="dot" aria-hidden />
    </Tag>
  );
}

function Shot({ name, alt }: { name: string; alt: string }) {
  return (
    <picture className="block overflow-hidden rounded-xl bg-sheet ring-1 ring-rule sm:rounded-2xl md:col-span-2">
      <source
        type="image/avif"
        srcSet={`/media/shots/${name}-1280.avif 1280w, /media/shots/${name}-2240.avif 2240w`}
        sizes="(min-width: 1280px) 1200px, 100vw"
      />
      <img
        src={`/media/shots/${name}-1280.webp`}
        alt={alt}
        width={2880}
        height={1800}
        loading="lazy"
        decoding="async"
        className="block h-auto w-full"
      />
    </picture>
  );
}

function Chapter({
  id,
  title,
  children,
  shot,
}: {
  id: string;
  title: string;
  children: ReactNode;
  shot: { name: string; alt: string };
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="mt-32 grid scroll-mt-10 items-baseline gap-x-14 gap-y-6 sm:mt-44 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
    >
      <div id={`${id}-title`}>
        <Heading>{title}</Heading>
      </div>
      <div className="max-w-[34rem] space-y-6">
        <p className="text-lg text-graphite">{children}</p>
        <PlayChapter id={id} />
      </div>
      <div className="mt-6 md:col-span-2 md:mt-10">
        <Shot {...shot} />
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <TourProvider>
      <div className="mx-auto max-w-[1248px] px-5 sm:px-8">
        <header className="flex h-20 items-center justify-between sm:h-24">
          <a
            href="#top"
            className="flex items-center gap-2.5 rounded-lg"
            aria-label="open-bot home"
          >
            <Logo className="size-8" />
            <span className="font-display text-xl font-semibold tracking-[-0.02em]">open-bot</span>
          </a>
          <nav aria-label="Sections" className="flex items-center gap-1 sm:gap-2">
            <a
              href="#tour"
              className="hidden rounded-full px-3 py-2 font-medium text-ink/75 hover:text-ink md:block"
            >
              Tour
            </a>
            <a
              href="#job"
              className="hidden rounded-full px-3 py-2 font-medium text-ink/75 hover:text-ink md:block"
            >
              How it works
            </a>
            <a
              href="#run"
              className="hidden rounded-full px-3 py-2 font-medium text-ink/75 hover:text-ink md:block"
            >
              Run it yourself
            </a>
            <a
              href={site.github}
              className="ml-2 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 font-medium text-white transition-colors hover:bg-ink/85"
            >
              <GitHubMark className="size-[18px]" />
              GitHub
            </a>
          </nav>
        </header>

        <main id="top">
          <section aria-labelledby="hero-title" className="pt-8 sm:pt-14">
            <div id="hero-title">
              <Heading as="h1">
                Your AI teammates, <br className="hidden lg:block" />
                and the computer they share
              </Heading>
            </div>
            <div className="mt-7 grid items-baseline gap-x-14 gap-y-5 sm:mt-9 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              <p className="max-w-[34rem] text-lg text-graphite md:order-2">
                Give each teammate a job. They do real work on one computer with a browser, a shell
                and files. You watch live, take over at any moment, and approve anything risky.
              </p>
              <p className="text-graphite md:order-1">
                Open source and self-hosted.{" "}
                <a
                  href={site.github}
                  className="font-medium text-ink underline decoration-rule decoration-2 underline-offset-4 hover:decoration-ink"
                >
                  Get the code
                </a>
              </p>
            </div>

            <div className="mt-10 sm:mt-14">
              <Monitor />
              <ChapterRail />
            </div>
          </section>

          <Chapter
            id="job"
            title="Give them a job"
            shot={{
              name: "job",
              alt: "The New teammate form with templates, a job description, starter automations and the rule for when to ask first.",
            }}
          >
            Start from a template like chief of staff, researcher or shopper, or write your own.
            Every teammate has a name, a job, its own memory, and a rule for when to ask you first.
          </Chapter>

          <Chapter
            id="watch"
            title="Watch them work"
            shot={{
              name: "watch",
              alt: "A chat with Milo next to his live screen, where he is comparing flights to Lisbon on Google Flights.",
            }}
          >
            Each teammate gets its own screen on one shared Linux computer, with a real browser, a
            shell and files. Ask Milo for flights to Lisbon and watch every click as it happens.
          </Chapter>

          <Chapter
            id="takeover"
            title="Take the wheel. Anytime"
            shot={{
              name: "takeover",
              alt: "Milo's screen under your control, with a note to hand it back: window seat, and only nonstop flights.",
            }}
          >
            Press Take over and that teammate stops using its screen right away. Sign in, fix
            something, then hand it back with a note, and it carries on from there.
          </Chapter>

          <Chapter
            id="approval"
            title="Nothing ships without your OK"
            shot={{
              name: "approval",
              alt: "Penny asking to pay $45 at Onyx Coffee Lab, with Approve and Deny buttons.",
            }}
          >
            Sending, publishing, buying and deleting wait for your decision, in the app or from your
            phone. Choose Always allow, and a teammate stops asking about the same thing.
          </Chapter>

          <Chapter
            id="swarm"
            title="Many hands at once"
            shot={{
              name: "swarm",
              alt: "Penny's helpers checking a kettle's price at four shops, each on a screen of its own.",
            }}
          >
            Give a teammate a big job, like checking a price at four shops. It splits the work
            across helpers, each on a screen of its own, and brings back one answer.
          </Chapter>

          <section id="more" aria-labelledby="more-title" className="mt-32 scroll-mt-10 sm:mt-44">
            <div className="grid items-baseline gap-x-14 gap-y-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              <div id="more-title">
                <Heading>And the rest</Heading>
              </div>
              <div className="max-w-[34rem]">
                <PlayChapter id="more" />
              </div>
            </div>
            <dl className="mt-12 grid gap-x-14 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {more.map((item) => (
                <div key={item.term} className="border-t border-rule pt-5">
                  <dt className="font-display text-xl font-semibold tracking-[-0.015em]">
                    {item.term}
                  </dt>
                  <dd className="mt-2 text-graphite">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section
            id="run"
            aria-labelledby="run-title"
            className="mt-32 grid scroll-mt-10 gap-x-14 gap-y-10 sm:mt-44 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
          >
            <div className="space-y-6">
              <div id="run-title">
                <Heading>Run it yourself</Heading>
              </div>
              <p className="max-w-[30rem] text-lg text-graphite">
                open-bot runs on your own Mac or server. You need Node 24, pnpm 10, Docker, and the
                Codex CLI signed in to ChatGPT.
              </p>
              <a
                href={`${site.github}#run-it-locally`}
                className="inline-block font-medium underline decoration-rule decoration-2 underline-offset-4 hover:decoration-ink"
              >
                Read the setup guide
              </a>
            </div>
            <figure className="overflow-hidden rounded-2xl bg-bezel text-white ring-1 ring-black/5">
              <figcaption className="flex items-center justify-between border-b border-white/10 py-2.5 pr-3 pl-5">
                <span className="text-sm text-white/60">Terminal</span>
                <CopyButton text={quickstart} />
              </figcaption>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.875rem] leading-[1.8]">
                <code>
                  {quickstart.split("\n").map((line) => {
                    const [command, comment] = line.split(/(?=#)/);
                    return (
                      <span key={line} className="block">
                        <span className="text-white/35 select-none">$ </span>
                        {command}
                        {comment && <span className="text-white/45">{comment}</span>}
                      </span>
                    );
                  })}
                </code>
              </pre>
            </figure>
          </section>
        </main>

        <footer className="mt-36 flex flex-col gap-6 border-t border-rule py-10 sm:mt-48 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Logo className="size-7" />
            <p className="text-graphite">Open source, self-hosted, and yours.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 font-medium">
            <a href={site.github} className="hover:underline hover:underline-offset-4">
              GitHub
            </a>
            <a href={tour.download} download className="hover:underline hover:underline-offset-4">
              Download the tour
            </a>
          </nav>
        </footer>
      </div>
    </TourProvider>
  );
}
