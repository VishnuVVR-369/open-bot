// Unit tests for the vocabulary guard (scripts/check/vocabulary.mjs): `pnpm test:scripts`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compare, countTerms, findTerms, standInName, words } from "./vocabulary.mjs";

describe("words", () => {
  it("splits camelCase, PascalCase, snake_case and SCREAMING_CASE", () => {
    assert.deepEqual(words("botId"), ["bot", "id"]);
    assert.deepEqual(words("BotSummary"), ["bot", "summary"]);
    assert.deepEqual(words("owner_bot_id"), ["owner", "bot", "id"]);
    assert.deepEqual(words("PER_BOT"), ["per", "bot"]);
    assert.deepEqual(words("HTTPBotClient"), ["http", "bot", "client"]);
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
    assert.deepEqual(findTerms("robot chatbot botd about bottom teammateId"), []);
  });

  it("ignores the product name, the Linux user and Telegram's BotFather", () => {
    const text = [
      'import { x } from "@open-bot/shared";',
      "process.env.OPEN_BOT_PLAN_BASE_URL; window.openBotDesktop;",
      'const home = "/home/bot/.codex"; // runs as the bot user, chown bot:bot',
      "Talk to BotFather.",
    ].join("\n");
    assert.deepEqual(findTerms(text), []);
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
});

describe("countTerms", () => {
  it("counts each term", () => {
    assert.deepEqual(countTerms("botId bots isPrimary"), { bot: 2, "primary teammate": 1 });
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
