import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecks } from "./fast.mjs";

const node = (source) => [process.execPath, "-e", source];

test("successful checks produce no output", () => {
  const messages = [];
  assert.equal(
    runChecks([node('console.log("verbose success"); console.error("successful warning")')], {
      report: (message) => messages.push(message),
    }),
    0,
  );
  assert.deepEqual(messages, []);
});

test("prints failures from both streams and still runs later checks", () => {
  const messages = [];
  const result = runChecks(
    [
      node('console.log("first failure"); console.error("diagnostic"); process.exit(7)'),
      node('console.error("later failure"); process.exit(8)'),
      node('console.log("quiet success")'),
    ],
    { report: (message) => messages.push(message) },
  );
  assert.equal(result, 1);
  assert.equal(messages.filter((message) => message.startsWith("Failed:")).length, 2);
  assert.ok(messages.includes("first failure"));
  assert.ok(messages.includes("diagnostic"));
  assert.ok(messages.includes("later failure"));
  assert.ok(!messages.includes("quiet success"));
});

test("a command that cannot start fails with its diagnostic", () => {
  const messages = [];
  assert.equal(runChecks([["/no-such-openbot-check"]], { report: (m) => messages.push(m) }), 1);
  assert.match(messages.join("\n"), /ENOENT/);
});
