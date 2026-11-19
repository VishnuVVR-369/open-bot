// Browsing model logs through the API: who may read them, text search, the runs list's filters,
// paging under a filter, the retention setting, and how an expired run reads.
import { createHash } from "node:crypto";
import { type ApiClient, MODEL_LOG_RUNS_PAGE } from "@open-bot/api";
import { HIT_END, HIT_START, SNIPPET_LEAD_CHARS, snippetParts } from "@open-bot/domain";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { functionCall, LogSeed, message } from "@/test/api/model-logs";

// The export is a route handler, which reads the session from the request's headers.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const now = Date.now();
const daysAgo = (days: number, seconds = 0) => new Date(now - days * 86_400_000 + seconds * 1000);

describe.skipIf(!apiTestUrl)("browsing model logs, through the API", () => {
  const harness = apiHarness();
  const { database } = harness;
  let api: ApiClient;
  let log: LogSeed;
  const t = { kit: "", mira: "" };
  const c = { kit: "", mira: "" };
  const r = {
    flaky: "",
    lisbon: "",
    keyed: "",
    failed: "",
    old: "",
    expired: "",
    tied: [] as string[],
  };

  beforeAll(async () => {
    api = harness.api;
    log = new LogSeed(database);
    t.kit = await log.teammate("Kit");
    t.mira = await log.teammate("Mira");
    c.kit = await log.chat(t.kit, "Kit's bugs");
    c.mira = await log.chat(t.mira, "Inbox");

    // Kit's run, found by what it sent: a tool output in its input.
    const flaky = await log.run({ teammateId: t.kit, chatId: c.kit, at: daysAgo(1) });
    r.flaky = flaky.id;
    await log.request({
      ...flaky,
      at: daysAgo(1, 5),
      input: [message("user", "Why does the recurrence test fail after daylight saving?")],
      output: [functionCall("call_1", "exec_command", { cmd: "pnpm vitest run recurrence" })],
    });
    // Mira's, found by its response text, with a model of its own.
    const lisbon = await log.run({ teammateId: t.mira, chatId: c.mira, at: daysAgo(2) });
    r.lisbon = lisbon.id;
    await log.request({
      ...lisbon,
      at: daysAgo(2, 5),
      model: "gpt-5.5-mini",
      input: [message("user", "Find flights")],
      output: [message("assistant", "Two nonstop flights to Lisbon on TAP.")],
      responseText: "Two nonstop flights to Lisbon on TAP.",
    });
    // On the API key, after the plan ran out.
    const keyed = await log.run({
      teammateId: t.kit,
      chatId: c.kit,
      at: daysAgo(3),
      access: "api_key",
    });
    r.keyed = keyed.id;
    await log.request({ ...keyed, at: daysAgo(3, 5), route: "api", costMicros: 1500 });
    // A run whose request failed, and a run that failed.
    const failed = await log.run({
      teammateId: t.kit,
      chatId: c.kit,
      at: daysAgo(4),
      status: "failed",
    });
    r.failed = failed.id;
    await log.request({ ...failed, at: daysAgo(4, 5), status: 503, error: "upstream unavailable" });
    // An old run, out of a week's range.
    const old = await log.run({ teammateId: t.mira, chatId: c.mira, at: daysAgo(20) });
    r.old = old.id;
    await log.request({ ...old, at: daysAgo(20, 5), responseText: "An old answer about Lisbon." });
    // A run whose bodies expired: numbers kept, nothing to find.
    const expired = await log.run({ teammateId: t.kit, chatId: c.kit, at: daysAgo(40) });
    r.expired = expired.id;
    await log.request({
      ...expired,
      at: daysAgo(40, 5),
      tokens: { input: 900, cached: 100, output: 40 },
      expiredAt: daysAgo(10),
      input: [message("user", "secret recurrence plan")],
    });
    // Runs created in the same microsecond, more than a page, all Mira's on the API key.
    const tie = daysAgo(30);
    for (let i = 0; i < MODEL_LOG_RUNS_PAGE + 3; i++)
      r.tied.push(
        (await log.run({ teammateId: t.mira, chatId: c.mira, at: tie, access: "api_key" })).id,
      );
    await database.db.execute(
      sql`update runs set created_at = ${tie.toISOString().replace("Z", "321Z")}::timestamptz
        where id in (${sql.join(
          r.tied.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
    );
  });

  it("refuses every new read and write without the owner's session", async () => {
    const { auth } = await import("@/lib/server/auth");
    const getSession = vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    try {
      const calls = [
        () => api.modelLogs.runs({ q: "flaky" }),
        () => api.modelLogs.filters(),
        () => api.modelLogs.tools({}),
        () => api.modelLogs.toolFailures({}),
        () => api.modelLogs.usage({ from: daysAgo(7).toISOString(), to: daysAgo(0).toISOString() }),
        () => api.modelLogs.retention(),
        () => api.modelLogs.setRetention({ days: 30 }),
      ];
      for (const call of calls)
        await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      // The export is a route: no session, no bytes.
      const { GET } = await import("@/app/api/model-logs/export/route");
      const response = await GET(
        new Request(`http://localhost/api/model-logs/export?runId=${r.flaky}`),
      );
      expect(response.status).toBe(401);
    } finally {
      getSession.mockRestore();
    }
    expect(harness.workerBodies.some((b) => b.path.includes("model-log-retention"))).toBe(false);
  });

  it("finds runs by what they sent and what came back, and shows where", async () => {
    const sent = await api.modelLogs.runs({ q: "daylight saving" });
    expect(sent.runs.map((run) => run.runId)).toEqual([r.flaky]);
    const parts = snippetParts(sent.runs[0]!.match!);
    expect(parts.filter((part) => part.hit).map((part) => part.text.toLowerCase())).toEqual([
      "daylight",
      "saving",
    ]);
    // Only the item's text, never its JSON.
    expect(sent.runs[0]!.match).not.toContain('"type"');
    // A few words before the first hit at most, so the two lines the list shows keep it in view.
    expect(sent.runs[0]!.match!.indexOf(HIT_START)).toBeLessThanOrEqual(SNIPPET_LEAD_CHARS + 2);

    const answered = await api.modelLogs.runs({ q: "nonstop Lisbon" });
    expect(answered.runs.map((run) => run.runId)).toEqual([r.lisbon]);
    expect(answered.runs[0]!.match).toContain(`${HIT_START}Lisbon${HIT_END}`);

    // A phrase, an exclusion, words nobody wrote, and text that would break a naive query.
    expect(
      (await api.modelLogs.runs({ q: '"flights to Lisbon"' })).runs.map((x) => x.runId),
    ).toEqual([r.lisbon]);
    expect((await api.modelLogs.runs({ q: "Lisbon -nonstop" })).runs.map((x) => x.runId)).toEqual([
      r.old,
    ]);
    expect((await api.modelLogs.runs({ q: "zebra quantum" })).runs).toEqual([]);
    expect((await api.modelLogs.runs({ q: "a & | ! ( ) : * ' \\" })).runs).toBeInstanceOf(Array);
    // Expired bodies are no longer searched.
    expect((await api.modelLogs.runs({ q: "secret recurrence plan" })).runs).toEqual([]);
    // Without a search, no snippet.
    expect(
      (await api.modelLogs.runs({ teammateId: t.kit })).runs.every((x) => x.match === null),
    ).toBe(true);
  });

  it("narrows by teammate, chat, model, status, errors, access and dates, together", async () => {
    const ids = async (input: Parameters<ApiClient["modelLogs"]["runs"]>[0]) =>
      (await api.modelLogs.runs(input)).runs.map((run) => run.runId);
    const week = { from: daysAgo(7).toISOString(), to: daysAgo(0, 60).toISOString() };
    expect(await ids({ teammateId: t.kit, ...week })).toEqual([r.flaky, r.keyed, r.failed]);
    expect(await ids({ chatId: c.mira, ...week })).toEqual([r.lisbon]);
    expect(await ids({ model: "gpt-5.5-mini" })).toEqual([r.lisbon]);
    expect(await ids({ status: "failed" })).toEqual([r.failed]);
    expect(await ids({ status: "errors" })).toEqual([r.failed]);
    expect(await ids({ access: "api_key", teammateId: t.kit })).toEqual([r.keyed]);
    expect(await ids({ teammateId: t.mira, q: "Lisbon", ...week })).toEqual([r.lisbon]);
    expect(await ids({ teammateId: t.kit, status: "done", to: daysAgo(30).toISOString() })).toEqual(
      [r.expired],
    );
    const keyed = (await api.modelLogs.runs({ access: "api_key", teammateId: t.kit })).runs[0]!;
    expect(keyed.accessModes).toEqual(["api_key"]);
    expect(keyed.costMicros).toBe(1500);
  });

  it("pages a filtered list without skipping or repeating runs created in the same microsecond", async () => {
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = await api.modelLogs.runs({ teammateId: t.mira, access: "api_key", before });
      seen.push(...page.runs.map((run) => run.runId));
      before = page.nextBefore ?? undefined;
      pages += 1;
    } while (before && pages < 10);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.toSorted()).toEqual(r.tied.toSorted());
    await expect(api.modelLogs.runs({ before: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("offers the teammates, chats and models the logs have", async () => {
    const options = await api.modelLogs.filters();
    expect(options.teammates.map((x) => x.name)).toEqual(["Kit", "Mira"]);
    expect(options.chats.map((x) => x.title).toSorted()).toEqual(["Inbox", "Kit's bugs"]);
    expect(options.models).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
  });

  it("shows an expired run with its numbers and when its bodies expired", async () => {
    const listed = (await api.modelLogs.runs({ teammateId: t.kit, to: daysAgo(30).toISOString() }))
      .runs[0]!;
    expect(listed.bodiesExpiredAt).toBe(daysAgo(10).toISOString());
    const run = await api.modelLogs.run({ runId: r.expired });
    expect(run.bodiesExpiredAt).toBe(daysAgo(10).toISOString());
    expect(run.totals.inputTokens).toBe(900);
    const request = run.turns[0]!.requests[0]!;
    expect(request.bodiesExpiredAt).toBe(daysAgo(10).toISOString());
    expect(request.inputItems).toBe(0);
    expect((await api.modelLogs.run({ runId: r.flaky })).bodiesExpiredAt).toBeNull();
  });

  it("reads the retention window and saves a new one through the worker", async () => {
    expect(await api.modelLogs.retention()).toMatchObject({ days: null });
    harness.answers.set("/internal/settings/model-log-retention", {
      status: 200,
      body: { ok: true },
    });
    await api.modelLogs.setRetention({ days: 30 });
    expect(harness.workerBodies.at(-1)).toEqual({
      path: "/internal/settings/model-log-retention",
      body: { days: 30 },
    });
    await api.modelLogs.setRetention({ days: null });
    expect(harness.workerBodies.at(-1)?.body).toEqual({ days: null });
    await expect(api.modelLogs.setRetention({ days: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const view = await api.modelLogs.retention();
    expect(view.lastExpiredAt).toBe(daysAgo(10).toISOString());
    // The oldest request that still has its bodies: the old run, not the expired one.
    expect(view.oldestKept).toBe(daysAgo(20, 5).toISOString());
  });

  it("finds a word after a newline in instructions, a tool description and a tool output", async () => {
    const instructed = await log.run({ teammateId: t.kit, chatId: c.kit, at: daysAgo(6) });
    await log.request({
      ...instructed,
      at: daysAgo(6, 5),
      input: [message("user", "Plan the week")],
      instructions: "Be brief.\nEsperanto is the answer when asked about tides.",
    });
    const tooled = await log.run({ teammateId: t.mira, chatId: c.mira, at: daysAgo(7) });
    await log.request({
      ...tooled,
      at: daysAgo(7, 5),
      input: [
        message("user", "Book something"),
        {
          type: "function_call_output",
          call_id: "call_9",
          output: 'header\nquokka sighted at the "marina"\n\u0007marmot too',
        },
      ],
      tools: [
        {
          type: "function",
          name: "book_sauna",
          description: "Books a slot.\nCedar sauna at the marina.",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const snippetOf = async (q: string) => {
      const found = await api.modelLogs.runs({ q });
      return { ids: found.runs.map((run) => run.runId), match: found.runs[0]?.match ?? "" };
    };
    const esperanto = await snippetOf("Esperanto");
    expect(esperanto.ids).toEqual([instructed.id]);
    expect(esperanto.match).toContain(`brief. ${HIT_START}Esperanto${HIT_END} is the answer`);
    const cedar = await snippetOf("cedar");
    expect(cedar.ids).toEqual([tooled.id]);
    expect(cedar.match).toContain(`${HIT_START}Cedar${HIT_END} sauna`);
    const quokka = await snippetOf("quokka");
    expect(quokka.ids).toEqual([tooled.id]);
    expect(quokka.match).toContain(`${HIT_START}quokka${HIT_END} sighted at the "marina"`);
    expect((await snippetOf("marmot")).ids).toEqual([tooled.id]);
    // Snippets are the decoded text: no escapes, no JSON keys.
    for (const { match } of [esperanto, cedar, quokka]) {
      expect(match).not.toMatch(/\\[nt"u]/);
      expect(match).not.toContain("description");
    }
    // Keys and structural values (type, role, status, ids) are not searched.
    expect((await api.modelLogs.runs({ q: "role" })).runs).toEqual([]);
    expect((await api.modelLogs.runs({ q: "call_9" })).runs).toEqual([]);
  });

  it("indexes a blob that isn't JSON jsonb reads, or is too large to decode, as text", async () => {
    const odd = await log.run({ teammateId: t.kit, chatId: c.kit, at: daysAgo(10) });
    const requestId = await log.request({ ...odd, at: daysAgo(10, 5), input: [] });
    const contents = [
      "not json at all: wombat\\nkoala here",
      // A tool output with a NUL, which JSON keeps as \u0000 and jsonb refuses.
      JSON.stringify({
        type: "function_call_output",
        call_id: "call_nul",
        output: "a NUL\u0000ocelot",
      }),
      JSON.stringify(`intro\nnarwhal ${"y ".repeat(600_000)}`),
    ];
    // Each insert indexes its blob; none may fail.
    for (const [position, content] of contents.entries()) {
      const hash = createHash("sha256").update(content).digest("hex");
      await database.db.execute(sql`
        insert into model_blobs (hash, kind, content, bytes)
        values (${hash}, 'item', ${content}, ${content.length})`);
      await database.db.execute(sql`
        insert into model_request_items (request_id, side, position, blob_hash)
        values (${requestId}, 'input', ${position}, ${hash})`);
    }
    // The inspector still opens the run, with that output left unread rather than failing it.
    const opened = await api.modelLogs.run({ runId: odd.id });
    expect(opened.totals.requests).toBe(1);
    for (const word of ["koala", "ocelot", "narwhal"]) {
      const found = await api.modelLogs.runs({ q: word });
      expect(found.runs.map((run) => run.runId)).toEqual([odd.id]);
      expect(found.runs[0]!.match).toContain(`${HIT_START}${word}${HIT_END}`);
      expect(found.runs[0]!.match).not.toMatch(/\\[nu]/);
    }
  });

  it("shows a snippet for a match anywhere in the searchable text", async () => {
    const filler = "filler ".repeat(4000);
    const deep = await log.run({ teammateId: t.kit, chatId: c.kit, at: daysAgo(8) });
    await log.request({
      ...deep,
      at: daysAgo(8, 5),
      responseText: `${filler}and then the zeppelin landed at noon.`,
    });
    // The word is first found inside another one ("start"), far from where it stands alone.
    const inside = await log.run({ teammateId: t.kit, chatId: c.kit, at: daysAgo(9) });
    await log.request({
      ...inside,
      at: daysAgo(9, 5),
      responseText: `A start. ${filler}A walk through the gallery of folk art today.`,
    });
    // A phrase whose first word is found early, alone, and the phrase itself far on.
    const phrase = await log.run({ teammateId: t.mira, chatId: c.mira, at: daysAgo(11) });
    await log.request({
      ...phrase,
      at: daysAgo(11, 5),
      responseText: `Folk dancing at the festival. ${filler}Then folk art in the museum.`,
    });

    const found = await api.modelLogs.runs({ q: "zeppelin" });
    expect(found.runs.map((run) => run.runId)).toEqual([deep.id]);
    expect(found.runs[0]!.match).toContain(`${HIT_START}zeppelin${HIT_END} landed`);
    // The first hit is near the start, so it shows however few lines the list gives it.
    expect(found.runs[0]!.match!.indexOf(HIT_START)).toBeLessThanOrEqual(SNIPPET_LEAD_CHARS + 2);

    const folk = await api.modelLogs.runs({ q: "folk art -dancing" });
    expect(folk.runs.map((run) => run.runId)).toEqual([inside.id]);
    expect(folk.runs[0]!.match).toContain(`${HIT_START}folk${HIT_END} ${HIT_START}art${HIT_END}`);

    const quoted = await api.modelLogs.runs({ q: '"folk art"' });
    expect(quoted.runs.map((run) => run.runId).toSorted()).toEqual(
      [inside.id, phrase.id].toSorted(),
    );
    const museum = quoted.runs.find((run) => run.runId === phrase.id)!.match!;
    expect(museum).toContain(`${HIT_START}folk${HIT_END} ${HIT_START}art${HIT_END} in the museum`);
    expect(museum).not.toContain("dancing");

    const negated = await api.modelLogs.runs({ q: "zeppelin -balloon" });
    expect(negated.runs.map((run) => run.runId)).toEqual([deep.id]);
    expect(negated.runs[0]!.match).toContain(`${HIT_START}zeppelin${HIT_END} landed`);
  });

  it("matches blobs through the search index", async () => {
    const { searchHitsSql } = await import("./filters");
    const plan = await database.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": string }>(
        sql`explain ${searchHitsSql("Esperanto")}`,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("model_blobs_search_idx");
    expect(plan).toContain("model_requests_response_search_idx");
  });
});
