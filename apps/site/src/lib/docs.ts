import type { Metadata } from "next";
import { site } from "./site";

export interface DocPage {
  href: string;
  title: string;
  /** One sentence, used for the page's meta description and the section index. */
  description: string;
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

/**
 * Every docs page, in reading order. The sidebar, the previous/next links, page metadata and the
 * sitemap all come from this list, so a new page only needs an entry here and its page.mdx.
 */
export const docs: DocSection[] = [
  {
    title: "Getting started",
    pages: [
      {
        href: "/docs",
        title: "Introduction",
        description: "What open-bot is, the problem it solves, and how these docs are organized.",
      },
      {
        href: "/docs/concepts",
        title: "Core concepts",
        description:
          "The vocabulary used everywhere else: teammates, chats, runs, threads, screens, leases and tools.",
      },
      {
        href: "/docs/quickstart",
        title: "Run it locally",
        description:
          "Start Postgres, the computer, the worker and the web app on your own machine.",
      },
    ],
  },
  {
    title: "Architecture",
    pages: [
      {
        href: "/docs/architecture",
        title: "System overview",
        description:
          "The five processes, how they talk to each other, and the design decisions behind the shape.",
      },
      {
        href: "/docs/architecture/web-app",
        title: "Web app",
        description:
          "The Next.js app: authentication, server actions, read routes and the live event stream.",
      },
      {
        href: "/docs/architecture/worker",
        title: "Worker",
        description:
          "The always-on Node service that runs teammates, their tools, schedules and approvals.",
      },
      {
        href: "/docs/architecture/computer",
        title: "The computer and botd",
        description:
          "The shared Linux machine: its image, users, screens, leases, cookie sync and apply guard.",
      },
      {
        href: "/docs/architecture/agent-runtime",
        title: "Agent runtime",
        description:
          "How the worker drives Codex app-server: threads, turns, dynamic tools and instructions.",
      },
      {
        href: "/docs/architecture/data",
        title: "Data and events",
        description:
          "The Postgres schema, the run queue, the append-only event log and the NOTIFY channels.",
      },
      {
        href: "/docs/architecture/desktop-and-egress",
        title: "Desktop app and egress",
        description:
          "The Electron shell and the multiplexed tunnel that sends browser traffic out through your Mac.",
      },
    ],
  },
  {
    title: "How it works",
    pages: [
      {
        href: "/docs/flows/chat-turn",
        title: "Life of a message",
        description:
          "One chat message end to end: from the composer to Codex and back to every open tab.",
      },
      {
        href: "/docs/flows/screens-and-takeover",
        title: "Screens and takeover",
        description:
          "Desktop actions, watching a screen live, taking over, handing back, and bot requests for help.",
      },
      {
        href: "/docs/flows/approvals",
        title: "Approvals",
        description:
          "Autonomy levels, Codex's native approvals, request_approval, and Always allow rules.",
      },
      {
        href: "/docs/flows/automations",
        title: "Automations",
        description: "Schedules, reminders, page watches, webhooks and quiet check-ins.",
      },
      {
        href: "/docs/flows/teamwork",
        title: "Teamwork and swarms",
        description:
          "Group chats, handoffs, questions between teammates, the task board and parallel helpers.",
      },
      {
        href: "/docs/flows/memory",
        title: "Memory",
        description:
          "Versioned, scoped memory in Postgres: retrieval, generations, forgetting and optional AI.",
      },
      {
        href: "/docs/flows/models-and-usage",
        title: "Models and usage",
        description:
          "ChatGPT plan sign-in, the automatic API key fallback, the monthly cap and the usage ledger.",
      },
      {
        href: "/docs/flows/vault-and-payments",
        title: "Vault and payments",
        description:
          "How teammates fill logins and cards they never see, and how budgets gate purchases.",
      },
      {
        href: "/docs/flows/skills-and-connections",
        title: "Skills and connections",
        description: "Saved procedures as Codex skills, and outside services through MCP servers.",
      },
      {
        href: "/docs/flows/channels",
        title: "Notifications and channels",
        description: "In-app and push notifications, Telegram, and an email address per teammate.",
      },
    ],
  },
  {
    title: "Operate",
    pages: [
      {
        href: "/docs/security",
        title: "Security model",
        description:
          "Trust boundaries, secrets, what each part can reach, and the risks that remain.",
      },
      {
        href: "/docs/deployment",
        title: "Deployment",
        description: "Run open-bot in the cloud: services, networking, secrets and first sign-in.",
      },
      {
        href: "/docs/development",
        title: "Development",
        description:
          "The monorepo layout, checks, test suites and the conventions the code follows.",
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        href: "/docs/reference/tools",
        title: "Teammate tools",
        description: "Every tool a teammate can call, what it does and who may call it.",
      },
      {
        href: "/docs/reference/http-api",
        title: "Internal APIs",
        description:
          "The worker's internal API, botd's API, their sockets and the public endpoints.",
      },
      {
        href: "/docs/reference/configuration",
        title: "Configuration",
        description: "Every environment variable for the web app, the worker and the computer.",
      },
    ],
  },
];

export const allDocs: DocPage[] = docs.flatMap((section) => section.pages);

export function docPage(href: string): DocPage {
  const page = allDocs.find((entry) => entry.href === href);
  if (!page) throw new Error(`${href} is not listed in src/lib/docs.ts`);
  return page;
}

export function sectionOf(href: string): DocSection | undefined {
  return docs.find((section) => section.pages.some((page) => page.href === href));
}

/** A page's metadata, from its entry above. Every page.mdx exports `metadata = docMetadata(href)`. */
export function docMetadata(href: string): Metadata {
  const page = docPage(href);
  const title = href === "/docs" ? "open-bot documentation" : `${page.title} - open-bot docs`;
  return {
    title: { absolute: title },
    description: page.description,
    alternates: { canonical: href },
    openGraph: {
      type: "article",
      url: href,
      siteName: site.name,
      title,
      description: page.description,
    },
    twitter: { card: "summary_large_image", title, description: page.description },
  };
}

/** Where a page's source lives on GitHub, for "Edit this page". */
export function sourceUrl(href: string): string {
  return `${site.github}/blob/main/apps/site/src/app${href}/page.mdx`;
}
