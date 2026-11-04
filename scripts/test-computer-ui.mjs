import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = process.env.SCREEN_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_phase2_test"))
  throw new Error("SCREEN_TEST_DATABASE_URL must select a disposable *_phase2_test database.");
const db = new pg.Pool({ connectionString: url });
const screenId = randomUUID();
try {
  await db.query(
    "insert into bots(id,name,slug,role,instructions,color) values($1::uuid,'Phone Screen Fixture',$1::text,'UI fixture','UI fixture','#42a5f5')",
    [screenId],
  );
  const args = [
    "--device",
    process.env.MOBILE_E2E_DEVICE ?? "emulator-5554",
    "test",
    "-e",
    `SCREEN_ID=${screenId}`,
    "-e",
    `E2E_EMAIL=${process.env.E2E_EMAIL ?? "phase2@example.test"}`,
    "-e",
    `E2E_PASSWORD=${process.env.E2E_PASSWORD ?? "phase2-emulator-fixture-only"}`,
    "-e",
    "DEV_CLIENT_URL=openbot://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081",
    "--test-output-dir",
    "apps/mobile/.maestro-results/computer",
    "apps/mobile/maestro/computer.yaml",
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.MAESTRO_BIN ?? "maestro", args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Maestro exited ${code}`)),
    );
  });
  const returned = await db.query("select note,status from desktop_takeovers where screen_id=$1", [
    screenId,
  ]);
  if (!returned.rows.some((row) => row.status === "ended" && row.note === "Checked from Android"))
    throw new Error("The Android hand-back note was not saved.");
  console.log(
    "PASS: emulator screens list, view, wake, takeover, trackpad toggle, keyboard, Back confirmation, hand-back, and persisted note.",
  );
} finally {
  await fetch(
    `${process.env.SCREEN_TEST_COMPUTER_URL ?? "http://127.0.0.1:17070"}/lease/user/release`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer phase2-local-computer-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ screenId, clearCode: true }),
    },
  ).catch(() => {});
  await fetch(
    `${process.env.SCREEN_TEST_COMPUTER_URL ?? "http://127.0.0.1:17070"}/screens/forget`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer phase2-local-computer-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ screenId }),
    },
  ).catch(() => {});
  await db.query("delete from bots where id=$1", [screenId]);
  await db.end();
}
