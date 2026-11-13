// Page tools: check, publish, list and read pages.
import { COMPUTER_PATHS, type PageCheckResult } from "@open-bot/domain";
import { z } from "zod";
import type { RunSession } from "../runs/session";
import { PageError } from "../services/pages";
import {
  defineTool,
  text,
  type ToolDefinition,
  type ToolDeps,
  toolItem,
  type ToolResponse,
} from "./define";

export const PAGE_TOOLS: ToolDefinition[] = [
  defineTool({
    name: "check_page",
    description:
      "Check a page before publishing it (see the page skill). Renders the file in a browser without network at a phone's width and a laptop's, and returns what's wrong (script errors, things it can't load, sideways scrolling on phones) with screenshots of both. Also gives a preview URL to open on your screen.",
    input: z.object({
      path: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          "The page's .html file: a path in your workspace like pages/kafka/index.html, or a full path under /home/bot.",
        ),
    }),
    helpers: "allowed",
    handle: ({ session, callId, args }, deps) => checkPage(deps, session, callId, args),
  }),
  defineTool({
    name: "publish_page",
    description:
      "Publish a page for the user: checks it, then stores it as a version they open in the app, and shows it in this chat as a card. Publishing the same file again, or giving page_id, adds a new version of the same page. Pages with errors aren't published; fix them and try again. Only the user can see a page, in their own app, so publishing one never needs approval.",
    input: z.object({
      path: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          "The page's .html file: a path in your workspace like pages/kafka/index.html, or a full path under /home/bot.",
        ),
      title: z
        .string()
        .min(1)
        .max(120)
        .describe("What the page is, in a few words, like 'How Kafka's tiered storage works'."),
      summary: z
        .string()
        .min(1)
        .max(400)
        .describe("One or two sentences on what the reader gets from it, for the card."),
      note: z
        .string()
        .max(1000)
        .describe("For a new version: what changed, like 'Added the failure modes section'.")
        .optional(),
      page_id: z
        .string()
        .uuid()
        .describe("Publish as a new version of this page (from list_pages or the user's message).")
        .optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => publishPage(deps, session, callId, args),
  }),
  defineTool({
    name: "list_pages",
    description:
      "List the pages teammates have published, newest first, with their page_id, versions, who made them and the file they came from.",
    input: z.object({}),
    helpers: "allowed",
    handle: async (_call, deps) => text(await deps.pages.describe()),
  }),
  defineTool({
    name: "get_page",
    description:
      "Read a page's versions and its text. With restore, also put its current version in your workspace to change it (needed when its file is gone or it's another teammate's page).",
    input: z.object({
      page_id: z.string().uuid(),
      restore: z.boolean().default(false),
    }),
    helpers: "allowed",
    handle: ({ session, args }, deps) => getPage(deps, session, args),
  }),
];

const publishPageArgs = z.object({
  path: z.string(),
  title: z.string().trim().min(1, "Give the page a title.").max(120),
  summary: z.string().trim().min(1, "Give the page a summary.").max(400),
  note: z.string().max(1000).optional(),
  page_id: z.string().uuid("Use a page_id from list_pages.").optional(),
});

/** A page's file as a full path: paths without a leading slash are in the teammate's workspace. */
function pagePath(session: RunSession, raw: unknown): string {
  const path = z.string().trim().min(1, "path is required").max(1000).parse(raw);
  return path.startsWith("/")
    ? path
    : `${COMPUTER_PATHS.workspace(session.bot.slug)}/${path.replace(/^\.\//, "")}`;
}

/** The check's findings, as the teammate reads them. */
function describeCheck(check: PageCheckResult, path: string): string {
  const errors = check.issues.filter((issue) => issue.level === "error");
  const warnings = check.issues.filter((issue) => issue.level === "warning");
  const lines = [
    `Checked ${path} (${(check.size / 1024).toFixed(0)} KB${check.title ? `, titled “${check.title}”` : ""}).`,
    errors.length || warnings.length
      ? `${errors.length} error${errors.length === 1 ? "" : "s"} and ${warnings.length} warning${warnings.length === 1 ? "" : "s"}:`
      : "No problems found. Still look at both screenshots before publishing.",
    ...errors.map((issue) => `- Error: ${issue.message}`),
    ...warnings.map((issue) => `- Warning: ${issue.message}`),
    "",
    `The screenshots below show the page on a phone (390px) and on a laptop (1280px), from the top. To click through it, open http://127.0.0.1:7080/preview?path=${encodeURIComponent(path)} on your screen (add &theme=dark for the dark theme).`,
  ];
  return lines.join("\n");
}

async function checkPage(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const path = pagePath(session, args.path);
  const item = toolItem(callId, "check_page", "Checked the page", args, session.now());
  session.putItem(item);
  const check = await deps.ctx.computer.checkPage(path);
  if (!check.ok) {
    session.putItem({
      ...item,
      status: "failed",
      completedAt: session.now(),
      error: check.message,
    });
    return text(check.message, false);
  }
  const errors = check.issues.filter((issue) => issue.level === "error").length;
  session.putItem({
    ...item,
    label: `Checked “${check.title || path.split("/").slice(-2).join("/")}”`,
    status: "completed",
    completedAt: session.now(),
    result: errors
      ? `${errors} problem${errors === 1 ? "" : "s"} to fix`
      : check.issues.length
        ? `Looks good, ${check.issues.length} note${check.issues.length === 1 ? "" : "s"}`
        : "Looks good",
  });
  return {
    success: true,
    contentItems: [
      { type: "inputText", text: describeCheck(check, path) },
      { type: "inputImage", imageUrl: `data:image/jpeg;base64,${check.screenshots.phone}` },
      { type: "inputImage", imageUrl: `data:image/jpeg;base64,${check.screenshots.desktop}` },
    ],
  };
}

async function publishPage(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const parsed = publishPageArgs.parse(args);
  const path = pagePath(session, parsed.path);
  const startedAt = session.now();
  const item = toolItem(callId, "publish_page", `Publishing “${parsed.title}”`, args, startedAt);
  session.putItem(item);
  const fail = (message: string) => {
    session.putItem({ ...item, status: "failed", completedAt: session.now(), error: message });
    return text(message, false);
  };
  let published;
  try {
    published = await deps.pages.checkAndPublish({
      botId: session.bot.id,
      chatId: session.chat.id,
      runId: session.run.id,
      path,
      title: parsed.title,
      summary: parsed.summary,
      note: parsed.note ?? "",
      ...(parsed.page_id ? { pageId: parsed.page_id } : {}),
    });
  } catch (error) {
    if (error instanceof PageError) return fail(error.message);
    throw error;
  }
  const { page, version, check } = published;
  session.putItem({
    id: callId,
    kind: "page",
    pageId: page.id,
    versionId: version.id,
    version: version.number,
    title: version.title,
    summary: version.summary,
    status: "completed",
    startedAt,
    completedAt: session.now(),
  });
  const warnings = check.issues.filter((issue) => issue.level === "warning");
  return text(
    [
      version.number === 1
        ? `Published “${version.title}” (page_id ${page.id}).`
        : `Published version ${version.number} of “${version.title}” (page_id ${page.id}).`,
      "It shows in this chat as a card the user can open, so don't paste the page or its HTML in your reply.",
      ...(warnings.length
        ? ["Warnings to consider next time:", ...warnings.map((issue) => `- ${issue.message}`)]
        : []),
    ].join("\n"),
  );
}

async function getPage(
  deps: ToolDeps,
  session: RunSession,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const pageId = z.string().uuid("Use a page_id from list_pages.").parse(args.page_id);
  const details = await deps.pages.describeOne(pageId);
  if (args.restore !== true) return text(details);
  const restored = await deps.pages.restore(pageId, session.bot);
  return text(`${restored}\n\n${details}`);
}
