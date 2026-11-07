// Builds the showcase database: realistic demo data for design review screenshots.
//
//   node --env-file=.env scripts/showcase/seed.mjs
//
// It only ever touches the database named `openbot_showcase`. The real development database
// (`openbot`) is used only to find the Postgres server and its credentials, and is never opened.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  announcementPage,
  checklistPage,
  itineraryPage,
  pricingComparisonPage,
  renderScreens,
  renderThumbnails,
} from "./assets.mjs";
import { seedConversations, seedTeam } from "./content-chats.mjs";
import {
  seedAutomations,
  seedConnections,
  seedMemory,
  seedNotifications,
  seedPages,
  seedTasksAndSkills,
  seedUsageAndSettings,
  seedVault,
} from "./content-rest.mjs";
import { Db, Seeder, ago, fmtDay, fmtShort, nextLaunchDay } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHOWCASE_DB = "openbot_showcase";
const OWNER = { name: "Alex Rivera", email: "alex@showcase.local", password: "showcase-demo-2026" };

/* ------------------------------------------------------------------ Safety */

function targetUrl() {
  const source = process.env.SHOWCASE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!source)
    throw new Error("Set DATABASE_URL (run with --env-file=.env) so the script can find Postgres.");
  const url = new URL(source);
  url.pathname = `/${SHOWCASE_DB}`;
  return url;
}

const target = targetUrl();
if (decodeURIComponent(target.pathname.slice(1)) !== SHOWCASE_DB) {
  console.error(`Refusing to run: the target database must be ${SHOWCASE_DB}.`);
  process.exit(1);
}
const admin = new URL(target);
admin.pathname = "/postgres";
const DATABASE_URL = target.toString();

/* ------------------------------------------------------------------ Database */

async function recreateDatabase() {
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    // The name is a constant checked above, never user input.
    await client.query(`drop database if exists ${SHOWCASE_DB} with (force)`);
    await client.query(`create database ${SHOWCASE_DB}`);
  } finally {
    await client.end();
  }
}

function migrate() {
  const result = spawnSync("pnpm", ["--filter", "@open-bot/db", "migrate"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Migrations failed");
}

/** better-auth's own password hash, so the real login form accepts the password. */
async function hashPassword(password) {
  const require = createRequire(path.join(root, "apps/web/package.json"));
  const crypto = await import(pathToFileURL(require.resolve("better-auth/crypto")).href);
  return crypto.hashPassword(password);
}

/* ------------------------------------------------------------------ Main */

console.log(`Seeding ${SHOWCASE_DB} on ${target.host}`);
await recreateDatabase();
console.log("Created a fresh database, running migrations");
migrate();

// Dates the story hangs on, all relative to now so the labels read naturally.
const launch = nextLaunchDay();
const dayMs = 86_400_000;
const confStart = new Date(launch.getTime() + 15 * dayMs);
const dates = {
  launch,
  freeze: new Date(launch.getTime() - 4 * dayMs),
  confStart,
  confEnd: new Date(confStart.getTime() + 3 * dayMs),
  outbound: new Date(confStart.getTime() - 2 * dayMs),
  back: new Date(confStart.getTime() + 3 * dayMs),
};

console.log("Rendering screenshots and page thumbnails");
const shots = await renderScreens({
  outbound: fmtShort(dates.outbound),
  back: fmtShort(dates.back),
  summitDays: `${fmtShort(confStart)} - ${fmtShort(dates.confEnd)}`,
});

const launchLabel = fmtDay(launch);
const freezeLabel = fmtDay(dates.freeze);
const itineraryDays = [
  {
    day: "Mon",
    date: fmtShort(dates.outbound),
    title: "Fly SFO to Lisbon",
    body: "TAP nonstop departing 6:15 PM. Sleep on the plane.",
  },
  {
    day: "Tue",
    date: fmtShort(new Date(confStart.getTime() - dayMs)),
    title: "Arrive, check in at The Quiet Fig",
    body: "Lands 11:05 AM. Check-in from 2 PM. Dinner near the hotel, early night.",
  },
  {
    day: "Wed",
    date: fmtShort(confStart),
    title: "Summit day 1",
    body: "Opening keynote at 9:30. The pricing talk at 11:00 is worth the room change.",
  },
  {
    day: "Thu",
    date: fmtShort(new Date(confStart.getTime() + dayMs)),
    title: "Investor 1:1 at 1:30 PM",
    body: "On the Terrace. Bring the retention chart and the two-minute funnels demo.",
  },
  {
    day: "Fri",
    date: fmtShort(new Date(confStart.getTime() + 2 * dayMs)),
    title: "Investor 1:1 at 10:00 AM",
    body: "Then the closing panel at 4:00. Dinner with Priya, optional.",
  },
  {
    day: "Sat",
    date: fmtShort(dates.back),
    title: "Fly home",
    body: "TAP nonstop departing 11:40 AM, lands 3:35 PM.",
  },
];
const pageHtml = {
  checklist: [
    checklistPage({ launch: launchLabel, freeze: freezeLabel, version: 1 }),
    checklistPage({ launch: launchLabel, freeze: freezeLabel, version: 2 }),
  ],
  itinerary: [itineraryPage({ days: itineraryDays })],
  pricing: [pricingComparisonPage()],
  announcement: [
    announcementPage({ version: 1 }),
    announcementPage({ version: 2 }),
    announcementPage({ version: 3 }),
  ],
};
const thumbs = await renderThumbnails(
  Object.fromEntries(
    Object.entries(pageHtml).flatMap(([key, versions]) =>
      versions.map((html, i) => [`${key}${i + 1}`, html]),
    ),
  ),
);
const pageIds = Object.fromEntries(
  Object.entries(pageHtml).map(([key, versions]) => [
    key,
    { id: randomUUID(), versions: versions.map(() => randomUUID()) },
  ]),
);

const encryptionKey = process.env.ENCRYPTION_KEY ?? "ZGV2LWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzLWxvbmc=";
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
const db = new Db(client);

try {
  await client.query("begin");

  // The owner. The password hash is better-auth's own, so the real sign-in form accepts it.
  const userId = randomBytes(16).toString("hex");
  await db.insert("user", {
    id: userId,
    name: OWNER.name,
    email: OWNER.email,
    emailVerified: true,
    createdAt: ago({ d: 36 }),
    updatedAt: ago({ d: 36 }),
  });
  await db.insert("account", {
    id: randomBytes(16).toString("hex"),
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(OWNER.password),
    createdAt: ago({ d: 36 }),
    updatedAt: ago({ d: 36 }),
  });

  const s = new Seeder(db, { shots, encryptionKey });
  const ctx = { db, s, encryptionKey, shots, thumbs, pageHtml, pageIds, dates, chats: {}, R: {} };

  await seedTeam(ctx);
  await seedConnections(ctx);
  await seedConversations(ctx);
  await seedAutomations(ctx);
  await seedPages(ctx);
  await seedTasksAndSkills(ctx);
  await seedVault(ctx);
  await seedMemory(ctx);
  await seedNotifications(ctx);
  await seedUsageAndSettings(ctx);
  await s.finish();

  await client.query("commit");
  console.log("\nSeeded:");
  for (const [table, count] of Object.entries(db.counts).sort())
    console.log(`  ${table.padEnd(24)} ${count}`);
  console.log(`\nSign in as ${OWNER.email} / ${OWNER.password}`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
