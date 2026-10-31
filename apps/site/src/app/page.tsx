import { CopyButton } from "@/components/copy-button";
import { Heading } from "@/components/heading";
import { GitHubMark, Logo } from "@/components/icons";
import { Story, type StoryChapter } from "@/components/story";
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

const story: StoryChapter[] = [
  {
    id: "job",
    title: "Give them a job",
    body: "Start from a template like chief of staff, researcher or shopper, or write your own. Every teammate has a name, a job, its own memory, and a rule for when to ask you first.",
    signal: "off",
    status: "Setting up Juno, a social media manager",
    shot: {
      name: "job",
      alt: "The New teammate form with templates, a job description, starter automations and the rule for when to ask first.",
    },
  },
  {
    id: "watch",
    title: "Watch them work",
    body: "Each teammate gets its own screen on one shared Linux computer, with a real browser, a shell and files. Ask Milo for flights to Lisbon and watch every click as it happens.",
    signal: "live",
    status: "Milo is comparing flights to Lisbon",
    shot: {
      name: "watch",
      alt: "A chat with Milo next to his live screen, where he is comparing flights to Lisbon on Google Flights.",
    },
  },
  {
    id: "takeover",
    title: "Take the wheel. Anytime",
    body: "Press Take over and that teammate stops using its screen right away. Sign in, fix something, then hand it back with a note, and it carries on from there.",
    signal: "manual",
    status: "You have control of Milo\u2019s screen",
    shot: {
      name: "takeover",
      alt: "Milo's screen under your control, with a note to hand it back: window seat, and only nonstop flights.",
    },
  },
  {
    id: "approval",
    title: "Nothing ships without your OK",
    body: "Sending, publishing, buying and deleting wait for your decision, in the app or from your phone. Choose Always allow, and a teammate stops asking about the same thing.",
    signal: "live",
    status: "Penny is waiting for your OK to pay $45",
    shot: {
      name: "approval",
      alt: "Penny asking to pay $45 at Onyx Coffee Lab, with Approve and Deny buttons.",
    },
  },
  {
    id: "swarm",
    title: "Many hands at once",
    body: "Give a teammate a big job, like checking a price at four shops. It splits the work across helpers, each on a screen of its own, and brings back one answer.",
    signal: "live",
    status: "Four helpers are checking kettle prices",
    shot: {
      name: "swarm",
      alt: "Penny's helpers checking a kettle's price at four shops, each on a screen of its own.",
    },
  },
];

const navLink =
  "hidden rounded-full px-3 py-2 font-medium text-ink/75 transition-colors hover:text-ink md:block";

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
            <a href="#tour" className={navLink}>
              Tour
            </a>
            <a href="#how" className={navLink}>
              How it works
            </a>
            <a href="#run" className={navLink}>
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
              <Heading as="h1" size="hero">
                Your AI teammates, <br className="hidden lg:block" />
                and the computer they share
              </Heading>
            </div>
            <div className="mt-7 flex flex-col gap-x-14 gap-y-5 sm:mt-9 md:flex-row md:items-end md:justify-between">
              <p className="max-w-[36rem] text-lg text-graphite">
                Give each teammate a job. They do real work on one computer with a browser, a shell
                and files. You watch live, take over at any moment, and approve anything risky.
              </p>
              <p className="shrink-0 text-lg text-graphite">
                Open source and self-hosted.{" "}
                <a
                  href={site.github}
                  className="font-medium text-ink underline decoration-rule decoration-2 underline-offset-4 transition-colors hover:decoration-ink"
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

          <div id="how" className="mt-16 scroll-mt-0 sm:mt-24 lg:mt-12">
            <Story chapters={story} />
          </div>

          <section
            id="more"
            aria-labelledby="more-title"
            className="mt-16 scroll-mt-10 border-t border-rule pt-16 sm:mt-24 sm:pt-24 lg:mt-12"
          >
            <div className="flex flex-col gap-x-14 gap-y-6 sm:flex-row sm:items-end sm:justify-between">
              <div id="more-title">
                <Heading>And the rest</Heading>
              </div>
              <div className="sm:pb-1">
                <PlayChapter id="more" />
              </div>
            </div>
            <dl className="mt-12 grid gap-x-10 gap-y-10 sm:mt-16 sm:grid-cols-2 lg:grid-cols-4 lg:gap-y-14">
              {more.map((item) => (
                <div key={item.term}>
                  <dt className="font-display text-xl font-semibold tracking-[-0.015em]">
                    {item.term}
                  </dt>
                  <dd className="mt-2 text-graphite">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </section>
        </main>
      </div>

      {/* The page ends the way the tour does: on black, with only the tally light. */}
      <div className="mt-28 bg-bezel text-white sm:mt-40">
        <div className="mx-auto max-w-[1248px] px-5 sm:px-8">
          <section
            id="run"
            aria-labelledby="run-title"
            className="grid scroll-mt-0 gap-x-14 gap-y-10 py-20 sm:py-28 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center"
          >
            <div>
              <div id="run-title">
                <Heading>Run it yourself</Heading>
              </div>
              <p className="mt-6 max-w-[30rem] text-lg text-white/65">
                open-bot runs on your own Mac or server. You need Node 24, pnpm 10, Docker, and the
                Codex CLI signed in to ChatGPT.
              </p>
              <a
                href={`${site.github}#run-it-locally`}
                className="mt-6 inline-block font-medium underline decoration-white/25 decoration-2 underline-offset-4 transition-colors hover:decoration-white"
              >
                Read the setup guide
              </a>
            </div>
            <figure className="overflow-hidden rounded-2xl bg-white/[0.04] ring-1 ring-white/10">
              <figcaption className="flex items-center justify-between border-b border-white/10 py-2.5 pr-3 pl-5">
                <span className="text-sm text-white/55">Terminal</span>
                <CopyButton text={quickstart} />
              </figcaption>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.875rem] leading-[1.8]">
                <code>
                  {quickstart.split("\n").map((line) => {
                    const [command, comment] = line.split(/(?=#)/);
                    return (
                      <span key={line} className="block">
                        <span className="text-white/30 select-none">$ </span>
                        {command}
                        {comment && <span className="text-white/40">{comment}</span>}
                      </span>
                    );
                  })}
                </code>
              </pre>
            </figure>
          </section>

          <footer className="flex flex-col gap-6 border-t border-white/10 py-10 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Logo className="size-7" />
              <p className="text-white/60">Open source, self-hosted, and yours.</p>
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
      </div>
    </TourProvider>
  );
}
