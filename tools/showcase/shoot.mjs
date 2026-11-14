// Screenshots every page of the showcase app and reports console and server errors.
//
//   node tools/showcase/shoot.mjs [outDir] [--dark] [--only=name,name]
//
// Needs the showcase server on :3200 and a storage state from auth.mjs.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.SHOWCASE_URL ?? "http://localhost:3200";
const STATE = process.env.SHOWCASE_STATE ?? "/tmp/ui/showcase-auth.json";
const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith("--")) ?? "/tmp/ui/showcase";
const dark = args.includes("--dark");
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",");

const require = createRequire(path.join(root, "package.json"));
const mod = await import(pathToFileURL(require.resolve("@playwright/test")).href);
const chromium = mod.chromium ?? mod.default.chromium;

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: BASE,
  storageState: STATE,
  viewport: { width: 1440, height: 900 },
  colorScheme: dark ? "dark" : "light",
  // The story is told in Pacific time, so times of day read the way the schedules say.
  timezoneId: "America/Los_Angeles",
  locale: "en-US",
});

/** Calls the app's API (`@open-bot/api`) as the signed-in browser does. */
const rpc = async (procedure) =>
  (await (await context.request.post(`/api/rpc/${procedure}`, { data: {} })).json()).json;
const state = await rpc("app/state");
const pages = (await rpc("pages/list").catch(() => [])) ?? [];
const chatByTitle = (text) => state.chats.find((chat) => chat.title.includes(text));

const targets = [
  ["home", "/"],
  ["approvals", "/approvals"],
  ["tasks", "/tasks"],
  ["automations", "/automations"],
  ["schedules", "/schedules"],
  ["skills", "/skills"],
  ["pages", "/pages"],
  ["vault", "/vault"],
  ["files", "/files"],
  ["computer", "/computer"],
  ["settings", "/settings"],
  ["teammate-new", "/teammates/new"],
  ...state.teammates.map((teammate) => [`teammate-${teammate.slug}`, `/teammates/${teammate.id}`]),
  ["chat-launch-plan", chatByTitle("launch plan")],
  ["chat-flights-approval", chatByTitle("Book the Lisbon")],
  ["chat-lisbon-research", chatByTitle("Lisbon trip research")],
  ["chat-kit-bug", chatByTitle("reminders fire")],
  ["chat-kit-migration", chatByTitle("migration dry run")],
  ["chat-inbox-triage", chatByTitle("Inbox triage")],
  ["chat-announcement", chatByTitle("announcement post")],
  ["chat-cms-takeover", chatByTitle("Publish the post")],
  ["chat-war-room", chatByTitle("war room")],
  ["chat-lisbon-group", state.chats.find((chat) => chat.title === "Lisbon trip")],
  ["chat-pricing", chatByTitle("Competitor pricing")],
  ["chat-email-inbox", state.chats.find((chat) => chat.kind === "inbox")],
  ...state.chats
    .filter((chat) => chat.kind === "scheduled")
    .map((chat, i) => [`chat-scheduled-${bySlug2(chat)}-${i}`, chat]),
  ...(pages[0] ? [["page-viewer", `/pages/${pages[0].id}`]] : []),
]
  .map(([name, target]) => [
    name,
    typeof target === "string" ? target : target ? `/chats/${target.id}` : null,
  ])
  .filter(([name, route]) => route && (!only || only.includes(name)));

function bySlug2(chat) {
  return state.teammates.find((teammate) => teammate.id === chat.teammateId)?.slug ?? "teammate";
}

let problems = 0;
for (const [name, route] of targets) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
  });
  try {
    await page.goto(route, { waitUntil: "networkidle", timeout: 120_000 });
  } catch (error) {
    errors.push(`navigation: ${error.message.split("\n")[0]}`);
  }
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(outDir, `${name}${dark ? "-dark" : ""}.png`),
    fullPage: false,
  });
  console.log(`${errors.length ? "!!" : "ok"}  ${name.padEnd(28)} ${route}`);
  for (const line of errors) console.log(`      ${line}`);
  problems += errors.length;
  await page.close();
}
await browser.close();
console.log(`\n${targets.length} pages, ${problems} problems. Screenshots in ${outDir}`);
