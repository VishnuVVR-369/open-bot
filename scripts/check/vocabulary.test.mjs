// Unit tests for the vocabulary guard (scripts/check/vocabulary.mjs): `pnpm test:scripts`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import {
  BASELINE,
  compare,
  countTerms,
  findTerms,
  growth,
  measure,
  standInName,
  words,
} from "./vocabulary.mjs";

describe("words", () => {
  it("splits camelCase, PascalCase, snake_case and SCREAMING_CASE", () => {
    assert.deepEqual(words("botId"), ["bot", "id"]);
    assert.deepEqual(words("BotSummary"), ["bot", "summary"]);
    assert.deepEqual(words("owner_bot_id"), ["owner", "bot", "id"]);
    assert.deepEqual(words("PER_BOT"), ["per", "bot"]);
    assert.deepEqual(words("HTTPBotClient"), ["http", "bot", "client"]);
  });

  it("splits digit suffixes and keeps non-ASCII letters inside a word", () => {
    assert.deepEqual(words("bot2"), ["bot", "2"]);
    assert.deepEqual(words("BOT2_ID"), ["bot", "2", "id"]);
    assert.deepEqual(words("cafébot"), ["cafébot"]);
    assert.deepEqual(words("ÉtatBot"), ["état", "bot"]);
  });

  it("keeps the product name as one word, but only at a word start", () => {
    assert.deepEqual(words("openBotDesktop"), ["open-bot", "desktop"]);
    assert.deepEqual(words("OPEN_BOT_PLAN"), ["open-bot", "plan"]);
    assert.deepEqual(words("open-bot-web"), ["open-bot", "web"]);
    assert.deepEqual(words("reopenBot"), ["reopen", "bot"]);
  });
});

describe("findTerms", () => {
  it("flags bot identifiers, strings and comments", () => {
    const text = 'const botId = "x";\n// the bots table\ncreateBot(BotSummary);';
    assert.deepEqual(
      findTerms(text).map(({ line, token }) => `${line}:${token}`),
      ["1:botId", "2:bots", "3:createBot", "3:BotSummary"],
    );
  });

  it("does not flag words that only contain the letters", () => {
    assert.deepEqual(findTerms("robot chatbot botd about bottom teammateId cafébot"), []);
  });

  it("flags digit suffixes and identifiers that only end in open", () => {
    const tokens = findTerms("bot2 BOT2_ID reopenBot").map((found) => found.token);
    assert.deepEqual(tokens, ["bot2", "BOT2_ID", "reopenBot"]);
  });

  it("ignores the product name, the Linux user and group, and Telegram's BotFather", () => {
    const text = [
      'import { x } from "@open-bot/domain";',
      "process.env.OPEN_BOT_PLAN_BASE_URL; window.openBotDesktop;",
      'const home = "/home/bot/.codex"; // runs as the bot user, chown bot:bot',
      "const botGroup = { uid: botUser.uid }; await botProcesses(); // the `bots` group",
      "sharedGid: env.BOTS_GID,",
      "Talk to BotFather.",
    ].join("\n");
    assert.deepEqual(findTerms(text), []);
  });

  it("still flags a teammate named like the Linux user's names", () => {
    const tokens = findTerms("botUsers botGrouping botProcess bots_gid the bots folder").map(
      (found) => found.token,
    );
    assert.deepEqual(tokens, ["botUsers", "botGrouping", "botProcess", "bots_gid", "bots"]);
  });

  it("skips lines marked vocabulary: allow", () => {
    assert.deepEqual(findTerms("telegram.botToken; // vocabulary: allow (Telegram's name)"), []);
  });

  it("flags primary only when it means the lead teammate", () => {
    const terms = (text) => findTerms(text).filter((found) => found.term === "primary teammate");
    assert.equal(terms("isPrimary is_primary setPrimaryBot primaryBotId").length, 4);
    assert.equal(terms('PRIMARY_NAV "text-primary" variant="primary" primaryColor').length, 0);
  });

  it("flags desktop takeovers but not the desktop app", () => {
    const terms = (text) => findTerms(text).filter((found) => found.term === "desktop takeover");
    assert.equal(terms("desktopTakeovers desktop_takeovers DesktopTakeover").length, 3);
    assert.equal(terms("DesktopView desktopApp screenTakeover").length, 0);
  });

  it("flags two-word phrases in prose and hyphenated words, once each", () => {
    const text = "// the desktop takeover, a Desktop-Takeover, desktop  takeovers\nthe primary bot";
    assert.deepEqual(
      findTerms(text).map(({ line, term, token }) => `${line}:${term}:${token}`),
      [
        "1:desktop takeover:desktop takeover",
        "1:desktop takeover:Desktop-Takeover",
        "1:desktop takeover:desktop takeovers",
        "2:bot:bot",
        "2:primary teammate:primary bot",
      ],
    );
  });

  it("does not join words across punctuation or line breaks", () => {
    assert.deepEqual(findTerms("desktop. Takeover\ndesktop\ntakeover"), []);
    assert.deepEqual(findTerms("set primary color"), []);
  });
});

describe("countTerms", () => {
  it("counts each term", () => {
    assert.deepEqual(countTerms("botId bots isPrimary"), { bot: 2, "primary teammate": 1 });
  });
});

describe("growth", () => {
  it("allows moving uses between files but not raising a total", () => {
    assert.deepEqual(growth({ "b.ts": { bot: 2 } }, { "a.ts": { bot: 2 } }), []);
    assert.deepEqual(growth({ "a.ts": { bot: 1 } }, { "a.ts": { bot: 2 } }), []);
    assert.deepEqual(growth({ "a.ts": { bot: 2 }, "b.ts": { bot: 1 } }, { "a.ts": { bot: 2 } }), [
      '"bot" 2 -> 3',
    ]);
  });
});

describe("standInName", () => {
  it("flags e2e test doubles named mock or fake", () => {
    assert.equal(standInName("e2e/telegram-mock.ts"), true);
    assert.equal(standInName("e2e/fake-google.ts"), true);
    assert.equal(standInName("e2e/accounts-stand-in.ts"), false);
    assert.equal(standInName("apps/web/src/mock-data.ts"), false);
  });
});

describe("compare", () => {
  const read = () => "const botId = 1;\nconst bots = [];";

  it("passes when the code matches the baseline", () => {
    assert.deepEqual(compare({ "a.ts": { bot: 2 } }, { "a.ts": { bot: 2 } }, read), []);
  });

  it("fails on a new use, naming the canonical term and the lines", () => {
    const [problem] = compare({ "a.ts": { bot: 2 } }, { "a.ts": { bot: 1 } }, read);
    assert.match(problem, /^a\.ts: 2 uses of "bot", 1 allowed\. New code says "teammate"\./);
    assert.match(problem, /Lines: 1 \(botId\), 2 \(bots\)/);
  });

  it("points to --show instead of listing many lines", () => {
    const many = () => "bot\n".repeat(9);
    const [problem] = compare({ "a.ts": { bot: 9 } }, { "a.ts": { bot: 8 } }, many);
    assert.match(problem, /List them with pnpm check:vocabulary --show a\.ts$/);
  });

  it("fails on a file the baseline does not know", () => {
    assert.equal(compare({ "new.ts": { bot: 2 } }, {}, read).length, 1);
  });

  it("fails when the baseline is higher than the code, so it can only shrink", () => {
    const [problem] = compare({}, { "a.ts": { bot: 3 } }, read);
    assert.match(
      problem,
      /allows 3 uses of "bot" but there are 0\. Run pnpm check:vocabulary --update/,
    );
  });

  it("asks to rename a test double file", () => {
    const [problem] = compare({ "e2e/x-mock.ts": { "mock (test double)": 1 } }, {}, read);
    assert.match(problem, /New code says "stand-in"\. Rename the file\./);
  });
});

describe("measure and the command line", () => {
  const script = fileURLToPath(new URL("./vocabulary.mjs", import.meta.url));
  let root;
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const baseline = () => JSON.parse(readFileSync(path.join(root, BASELINE), "utf8"));

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "vocabulary-"));
    git("init", "-q");
    mkdirSync(path.join(root, path.dirname(BASELINE)), { recursive: true });
    write(".gitignore", "dist/\n");
    write("apps/web/tracked.ts", "const botId = 1;\n");
    git("add", ".");
    write("apps/web/untracked.ts", "isPrimary;\n");
    write("apps/web/dist/ignored.ts", "botId;\n");
    write("packages/agent/src/protocol/generated.ts", "botId;\n");
    write("docs.md", "the bot\n");
    write("e2e/telegram-mock.ts", "export {};\n");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("measures tracked and untracked code, skipping ignored, excluded and non-code files", () => {
    assert.deepEqual(measure(root), {
      "apps/web/tracked.ts": { bot: 1 },
      "apps/web/untracked.ts": { "primary teammate": 1 },
      "e2e/telegram-mock.ts": { "mock (test double)": 1 },
    });
  });

  it("writes a baseline the check then accepts", () => {
    assert.equal(run().status, 1);
    const update = run("--update", "--allow-growth");
    assert.equal(update.status, 0, update.output);
    assert.equal(baseline()["apps/web/tracked.ts"].bot, 1);
    const check = run();
    assert.equal(check.status, 0, check.output);
    assert.match(check.output, /3 legacy uses left/);
  });

  it("fails on a new use, and --update refuses to absorb it", () => {
    run("--update", "--allow-growth");
    write("apps/web/new.ts", "const bots = [];\n");
    const check = run();
    assert.equal(check.status, 1);
    assert.match(
      check.output,
      /apps\/web\/new\.ts: 1 uses of "bot", 0 allowed\..*Lines: 1 \(bots\)/,
    );
    const update = run("--update");
    assert.equal(update.status, 1);
    assert.match(update.output, /"bot" 1 -> 2/);
    assert.equal(baseline()["apps/web/new.ts"], undefined);
  });

  it("lets --update follow a moved file and shrink a stale baseline", () => {
    run("--update", "--allow-growth");
    git("mv", "apps/web/tracked.ts", "apps/web/moved.ts");
    write("apps/web/untracked.ts", "lead;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--update").status, 0);
    assert.deepEqual(baseline()["apps/web/moved.ts"], { bot: 1 });
    assert.equal(baseline()["apps/web/untracked.ts"], undefined);
    assert.equal(run().status, 0);
  });

  it("lists a file's uses with --show, and explains a missing file", () => {
    const show = run("--show", "apps/web/tracked.ts");
    assert.equal(show.status, 0);
    assert.equal(show.output, "apps/web/tracked.ts:1: botId (bot)\n");
    assert.equal(run("--show").status, 2);
    assert.equal(run("--show", "nope.ts").status, 2);
  });
});
