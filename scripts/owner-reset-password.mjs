#!/usr/bin/env node
// Sets a new sign-in password for open-bot's owner, for when it's forgotten and there's no
// passkey to get back in with. open-bot sends no email, so this is the recovery path: it needs
// the server itself (its environment and database), which only the owner has.
//
//   pnpm owner:reset-password you@example.com
//
// The email must be the owner's (OWNER_EMAIL). The new password is typed twice, hidden, or read
// from the first line of stdin when it's piped. Every session is signed out afterwards.
// Passkeys keep working.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The same limits as sign-in: apps/web/src/lib/password.ts.
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = createRequire(path.join(root, "apps/web/package.json"));

const USAGE = `Set a new password for open-bot's owner.

  pnpm owner:reset-password <owner email>

Run it where open-bot runs, with its environment (OWNER_EMAIL and DATABASE_URL).
It asks for the new password twice; piped, it reads the first line of stdin.
Every device is signed out afterwards. Passkeys keep working.`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** One line from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          fail("Cancelled. Nothing changed.");
        }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

async function readPiped() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/)[0] ?? "";
}

async function newPassword() {
  if (!process.stdin.isTTY) return readPiped();
  const first = await askHidden("New password: ");
  const second = await askHidden("New password again: ");
  if (first !== second) fail("The passwords don't match. Nothing changed.");
  return first;
}

/* ------------------------------------------------------------------ Checks */

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const email = (args.find((arg) => !arg.startsWith("-")) ?? "").trim().toLowerCase();
const ownerEmail = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
const databaseUrl = process.env.DATABASE_URL;

if (!email) fail(`Give the owner's email.\n\n${USAGE}`);
if (!ownerEmail) fail("OWNER_EMAIL isn't set. Run this where open-bot runs, with its environment.");
if (email !== ownerEmail) fail("That isn't the owner's email (OWNER_EMAIL). Nothing changed.");
if (!databaseUrl)
  fail("DATABASE_URL isn't set. Run this where open-bot runs, with its environment.");

const password = await newPassword();
if (password.length < PASSWORD_MIN_LENGTH)
  fail(`Use at least ${PASSWORD_MIN_LENGTH} characters. Nothing changed.`);
if (password.length > PASSWORD_MAX_LENGTH)
  fail(`Use at most ${PASSWORD_MAX_LENGTH} characters. Nothing changed.`);

/* ------------------------------------------------------------------ Reset */

// better-auth's own hash, so the sign-in form accepts the password.
const { hashPassword } = await import(pathToFileURL(web.resolve("better-auth/crypto")).href);
const { default: pg } = await import(pathToFileURL(web.resolve("pg")).href);

const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
} catch (error) {
  fail(`Couldn't reach the database: ${error instanceof Error ? error.message : error}`);
}
try {
  await client.query("begin");
  const { rows: users } = await client.query(
    `select id from "user" where lower(email) = $1 for update`,
    [email],
  );
  const user = users[0];
  if (!user) {
    await client.query("rollback");
    fail("There's no account for that email yet. Create it on the sign-in page instead.");
  }
  const hash = await hashPassword(password);
  const updated = await client.query(
    `update account set password = $1, updated_at = now()
     where user_id = $2 and provider_id = 'credential'`,
    [hash, user.id],
  );
  if (updated.rowCount === 0) {
    // An owner who only ever used a passkey gets a password the way better-auth links one.
    await client.query(
      `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomBytes(16).toString("hex"), user.id, hash],
    );
  }
  const sessions = await client.query(`delete from session where user_id = $1`, [user.id]);
  await client.query("commit");
  console.log(
    `Password changed for ${email}. Signed out ${sessions.rowCount} ${sessions.rowCount === 1 ? "session" : "sessions"}; sign in with the new password.`,
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  fail(`Couldn't change the password: ${error instanceof Error ? error.message : error}`);
} finally {
  await client.end();
}
