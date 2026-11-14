import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import { createWorkerClient } from "@open-bot/api/worker";
import {
  accountActions,
  accounts,
  approvalRules,
  approvals,
  bots as teammateRows, // vocabulary: allow
  chatMembers,
  chats,
  connections,
  credentials,
  egressDevices,
  instructionProposals,
  lessons,
  LOCKS,
  memoryItems,
  messages,
  notifications,
  oauthClients,
  pages,
  runs,
  schedules as scheduleRows,
  settings,
  triggers as triggerRows,
  vaultItems,
} from "@open-bot/db";
import { BUNDLE_FORMAT, BUNDLE_VERSION, type TeammateBundle } from "@open-bot/domain";
import { decryptSecret, hashDeviceSecret } from "@open-bot/domain/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { mainChat, REUSED_ID } from "../features/chat";
import { rpcEnabled, rpcHarness, failure, ID } from "../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const {
    pool,
    db,
    codexStatus,
    ctx,
    sync,
    memory,
    teammates,
    executor,
    accountStore,
    accountActionLoop,
    relay,
    server,
    worker,
    newTeammate,
    racedWhileLocked,
    teammateWithRun,
  } = h;

  it("status: reports the computer, Codex and egress without waking anything", async () => {
    expect(await worker.status.get()).toEqual({
      computer: { online: true, health: null, lifecycle: null },
      codex: codexStatus,
      egress: OFFLINE_EGRESS_STATUS,
    });
  });

  it("refuses a caller without the worker's secret", async () => {
    const stranger = createWorkerClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secret: "wrong",
    });
    expect(await failure(stranger.status.get())).toEqual({ status: 401, message: "unauthorized" });
    expect(await db.select().from(chats).where(eq(chats.id, ID))).toEqual([]);
  });

  describe("settings, secrets and email writes", () => {
    const ownerRow = async () => (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const secret = async (kind: "openai_api_key" | "postmark_token") => {
      const [row] = await db.select().from(credentials).where(eq(credentials.kind, kind));
      return row
        ? { secret: decryptSecret(row.encrypted, ctx.env.ENCRYPTION_KEY), hint: row.hint }
        : null;
    };

    it("sets the time zone and the monthly cap, refusing a zone that doesn't exist", async () => {
      await worker.settings.setTimezone({ timezone: "Europe/Paris" });
      await worker.settings.setMonthlyCap({ dollars: 12.345 });
      expect(await ownerRow()).toMatchObject({
        timezone: "Europe/Paris",
        monthlyCapMicros: 12_345_000,
      });
      expect(await failure(worker.settings.setTimezone({ timezone: "Mars/Olympus" }))).toEqual({
        status: 400,
        message: "Unknown timezone.",
      });
      // Before the worker made the row, a change still lands (the web app's update didn't).
      await db.delete(settings);
      await worker.settings.setTimezone({ timezone: "Asia/Kolkata" });
      expect(await ownerRow()).toMatchObject({
        timezone: "Asia/Kolkata",
        monthlyCapMicros: 20_000_000,
      });
    });

    it("keeps one encrypted API key, replaced by the next, and removes it", async () => {
      const first = `sk-${"a".repeat(24)}`;
      const second = `sk-${"b".repeat(24)}`;
      await worker.settings.saveApiKey({ apiKey: first });
      await worker.settings.saveApiKey({ apiKey: second });
      expect(await secret("openai_api_key")).toEqual({ secret: second, hint: "sk-…bbbb" });
      expect(await failure(worker.settings.saveApiKey({ apiKey: "nope" }))).toMatchObject({
        status: 400,
      });
      await worker.settings.removeApiKey();
      expect(await secret("openai_api_key")).toBeNull();
    });

    it("makes the email row once, saves the domain and token, and keeps the token when left empty", async () => {
      const first = await worker.email.status();
      expect(first).toMatchObject({ domain: null, tokenHint: null, addresses: [] });
      expect(first.inboundPath).toMatch(/^\/api\/inbound\/email\/[\w-]{24}$/);
      expect((await worker.email.status()).inboundPath).toBe(first.inboundPath);

      const token = "postmark-token-0123456789";
      await worker.email.save({ domain: "https://www.Team.Example.com/", token });
      await newTeammate("Mailer", "writes email");
      const saved = await worker.email.status();
      expect(saved).toMatchObject({ domain: "team.example.com", tokenHint: "pos…6789" });
      expect(saved.addresses).toContainEqual(
        expect.objectContaining({
          name: "Mailer",
          address: expect.stringMatching(/@team\.example\.com$/),
        }),
      );
      expect(await secret("postmark_token")).toMatchObject({ secret: token });

      await worker.email.save({ domain: "team.example.com", token: "" });
      expect(await secret("postmark_token")).toMatchObject({ secret: token });
      expect(await failure(worker.email.save({ domain: "not a domain", token: "" }))).toEqual({
        status: 400,
        message: "Give a domain, like team.example.com.",
      });
      expect(await failure(worker.email.save({ domain: "", token: "short" }))).toEqual({
        status: 400,
        message: "That doesn't look like a Postmark server token.",
      });
      expect((await worker.email.status()).domain).toBe("team.example.com");

      await worker.email.removeToken();
      expect(await secret("postmark_token")).toBeNull();
      await worker.email.save({ domain: "", token: "" });
      expect(await worker.email.status()).toMatchObject({ domain: null, tokenHint: null });
    });
  });

  describe("vault, page and notification writes", () => {
    const login = {
      id: null,
      kind: "login" as const,
      name: "GitHub",
      domain: "https://github.com/login",
      teammateIds: null,
      secret: { username: "alex", password: "hunter22" },
    };
    const vaultSecret = async (itemId: string): Promise<Record<string, string>> => {
      const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, itemId));
      return JSON.parse(decryptSecret(row!.encrypted, ctx.env.ENCRYPTION_KEY));
    };

    it("saves a login encrypted, keeps fields left empty when editing, and removes it", async () => {
      const { id } = await worker.vault.save(login);
      const [saved] = await db.select().from(vaultItems).where(eq(vaultItems.id, id));
      expect(saved).toMatchObject({ domain: "github.com", hint: "alex" });
      expect(saved!.encrypted).not.toContain("hunter22");
      await worker.vault.save({
        ...login,
        id,
        name: "GitHub work",
        secret: { username: "alex", password: "" },
      });
      expect(await vaultSecret(id)).toEqual({ username: "alex", password: "hunter22" });
      expect(await failure(worker.vault.save({ ...login, id, kind: "card" }))).toEqual({
        status: 400,
        message: "An item can't change its kind.",
      });
      expect(await failure(worker.vault.save({ ...login, id: ID }))).toEqual({
        status: 404,
        message: "That item is no longer in the vault.",
      });
      expect(await failure(worker.vault.save({ ...login, secret: { username: "alex" } }))).toEqual({
        status: 400,
        message: "Add the password.",
      });
      await worker.vault.remove({ itemId: id });
      await worker.vault.remove({ itemId: id });
      expect(await db.select().from(vaultItems).where(eq(vaultItems.id, id))).toEqual([]);
    });

    it("keeps both of two card edits made at once", async () => {
      const card = {
        id: null,
        kind: "card" as const,
        name: "Visa",
        domain: "",
        teammateIds: null,
        secret: {
          number: "4242 4242 4242 4242",
          expiry: "12/40",
          cvc: "123",
          name: "Alex",
          zip: "",
        },
      };
      const { id } = await worker.vault.save(card);
      const edit = (secret: Record<string, string>) => worker.vault.save({ ...card, id, secret });
      await racedWhileLocked(
        "select 1 from vault_items where id = $1 for update",
        () => [edit({ cvc: "999" }), edit({ zip: "10115" })],
        [id],
      );
      expect(await vaultSecret(id)).toMatchObject({ cvc: "999", zip: "10115" });
      await worker.vault.remove({ itemId: id });
    });

    it("pins and deletes a page, and says one that's gone is gone", async () => {
      const { created } = await teammateWithRun();
      const [page] = await db
        .insert(pages)
        .values({ title: "Trip plan", botId: created.id }) // vocabulary: allow
        .returning();
      await worker.pages.pin({ pageId: page!.id, pinned: true });
      const reload = async () => (await db.select().from(pages).where(eq(pages.id, page!.id)))[0];
      expect((await reload())!.pinned).toBe(true);
      await worker.pages.remove({ pageId: page!.id });
      expect(await reload()).toBeUndefined();
      expect(await failure(worker.pages.pin({ pageId: page!.id, pinned: false }))).toEqual({
        status: 404,
        message: "That page was deleted.",
      });
    });

    it("marks notifications read by id, up to one, or all", async () => {
      await db.update(notifications).set({ readAt: new Date() });
      const added = [];
      for (const title of ["One", "Two", "Three", "Four"]) {
        const [row] = await db
          .insert(notifications)
          .values({ kind: "run_finished", title })
          .returning();
        added.push(row!);
      }
      const unread = async () =>
        (await db.select().from(notifications).where(isNull(notifications.readAt)))
          .map((row) => row.title)
          .sort();
      await worker.notifications.markRead({ ids: [added[3]!.id] });
      expect(await unread()).toEqual(["One", "Three", "Two"]);
      await worker.notifications.markRead({ through: added[1]!.id });
      expect(await unread()).toEqual(["Three"]);
      await worker.notifications.markRead({});
      expect(await unread()).toEqual([]);
    });
  });

  describe("connection, account and phone writes", () => {
    const server = {
      id: null,
      label: "Linear",
      transport: "http" as const,
      url: "https://mcp.linear.test/mcp",
      command: "",
      args: "",
      secrets: "Authorization: Bearer abc",
      teammateIds: null,
    };
    const connection = async (id: string) =>
      (await db.select().from(connections).where(eq(connections.id, id)))[0];

    /** A Google account with a Gmail connection, and a teammate's action waiting on it. */
    async function gmailWithWaitingAction() {
      const [client] = await db
        .insert(oauthClients)
        .values({ provider: "google", source: "owner", clientId: `client-${randomUUID()}` })
        .returning();
      const [account] = await db
        .insert(accounts)
        .values({
          provider: "google",
          externalId: `sub-${randomUUID()}`,
          oauthClientId: client!.id,
          display: "alex@example.test",
          encrypted: "not-read-here",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        })
        .returning();
      const linked = await worker.connections.linkAccount({
        accountId: account!.id,
        kind: "gmail",
        capabilities: ["read", "made-up"],
        teammateIds: null,
      });
      const { created, run } = await teammateWithRun();
      // Made like a teammate's action: under the account's grant and the connection's setup now.
      const waiting = async () => {
        const [current] = await db
          .select({ grantRevision: accounts.grantRevision })
          .from(accounts)
          .where(eq(accounts.id, account!.id));
        const [approval] = await db
          .insert(approvals)
          .values({
            runId: run.id,
            botId: created.id, // vocabulary: allow
            chatId: created.chatId,
            kind: "account_outward",
            title: "Send it",
            itemId: `approval-${randomUUID()}`,
          })
          .returning();
        const [action] = await db
          .insert(accountActions)
          .values({
            connectionId: linked.connectionId,
            accountId: account!.id,
            grantRevision: current!.grantRevision,
            connectionRevision: (await connection(linked.connectionId))!.revision,
            botId: created.id, // vocabulary: allow
            runId: run.id,
            chatId: created.chatId,
            itemId: `item-${randomUUID()}`,
            tool: "gmail.send_draft",
            effect: "outward",
            request: {},
            summary: "Send it",
            labels: { waiting: "Waiting", done: "Sent", failed: "Didn't send" },
            status: "pending",
            approvalId: approval!.id,
            expiresAt: new Date(Date.now() + 86_400_000),
          })
          .returning();
        return { actionId: action!.id, approvalId: approval!.id };
      };
      const outcome = async ({ actionId, approvalId }: Awaited<ReturnType<typeof waiting>>) => ({
        action: (await db.select().from(accountActions).where(eq(accountActions.id, actionId)))[0]!
          .status,
        approval: (await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!
          .status,
      });
      return { account: account!, connectionId: linked.connectionId, waiting, outcome };
    }

    it("saves an MCP server, keeps its headers when left empty, and names copies apart", async () => {
      const { id } = await worker.connections.save(server);
      await worker.connections.save({ ...server, id, label: "Linear (work)", secrets: "" });
      const saved = await connection(id);
      expect(saved).toMatchObject({
        label: "Linear (work)",
        name: "linear",
        secretNames: ["Authorization"],
      });
      expect(JSON.parse(decryptSecret(saved!.encrypted!, ctx.env.ENCRYPTION_KEY))).toEqual({
        headers: { Authorization: "Bearer abc" },
      });

      // Names are unique: three saves held at once each get their own.
      const copies = await racedWhileLocked("lock table connections in exclusive mode", () =>
        [1, 2, 3].map(() => worker.connections.save(server)),
      );
      const names = await Promise.all(
        copies.map(async (copy) => (await connection(copy.id))!.name),
      );
      expect(names.sort()).toEqual(["linear_2", "linear_3", "linear_4"]);

      expect(
        await failure(worker.connections.save({ ...server, transport: "stdio", command: "" })),
      ).toEqual({ status: 400, message: "Give the command the computer runs." });
      expect(await failure(worker.connections.save({ ...server, id: ID }))).toEqual({
        status: 404,
        message: "That connection is gone.",
      });
      await worker.connections.setEnabled({ connectionId: id, enabled: false });
      expect((await connection(id))!.enabled).toBe(false);
      expect(
        await failure(worker.connections.setEnabled({ connectionId: ID, enabled: true })),
      ).toEqual({ status: 404, message: "That connection is gone." });
      for (const copy of [{ id }, ...copies])
        expect(await worker.connections.remove({ connectionId: copy.id })).toEqual({
          warning: null,
        });
      expect(await connection(id)).toBeUndefined();
      expect(accountStore.revoke).not.toHaveBeenCalled();
    });

    it("links an account once, and cancels what waits on a connection that changes or goes", async () => {
      const gmail = await gmailWithWaitingAction();
      const linked = (await connection(gmail.connectionId))!;
      expect(linked).toMatchObject({ kind: "gmail", label: "Gmail", capabilities: ["read"] });
      expect(await failure(worker.connections.save({ ...server, id: gmail.connectionId }))).toEqual(
        { status: 400, message: "That's an account, not an MCP server." },
      );

      // Signing in again for the same access changes nothing.
      const again = {
        accountId: gmail.account.id,
        kind: "gmail" as const,
        capabilities: ["read"],
        teammateIds: null,
      };
      let action = await gmail.waiting();
      await worker.connections.linkAccount(again);
      expect((await connection(gmail.connectionId))!.revision).toBe(linked.revision);
      expect(await gmail.outcome(action)).toEqual({ action: "pending", approval: "pending" });
      // A sign-in that changed the grant (saveGrant moved its revision on), whose call here failed:
      // trying again still cancels what waits on the earlier grant, and only that.
      await db.update(accounts).set({ grantRevision: 2 }).where(eq(accounts.id, gmail.account.id));
      await worker.connections.linkAccount(again);
      expect(await gmail.outcome(action)).toEqual({ action: "cancelled", approval: "expired" });
      expect(accountActionLoop.kick).toHaveBeenCalled();
      const madeUnderNewGrant = await gmail.waiting();
      await worker.connections.linkAccount(again);
      expect(await gmail.outcome(madeUnderNewGrant)).toEqual({
        action: "pending",
        approval: "pending",
      });

      // Asking for more than the account granted changes nothing.
      const change = {
        connectionId: gmail.connectionId,
        capabilities: ["read"],
        teammateIds: null,
        askBeforeActing: false,
      };
      action = await gmail.waiting();
      expect(
        await worker.connections.updateAccount({ ...change, capabilities: ["read", "compose"] }),
      ).toEqual({ needsConsent: true });
      // How it asks isn't a new setup; who uses it is.
      expect(await worker.connections.updateAccount(change)).toEqual({ needsConsent: false });
      expect(await gmail.outcome(action)).toEqual({ action: "pending", approval: "pending" });
      const { created } = await teammateWithRun();
      await worker.connections.updateAccount({ ...change, teammateIds: [created.id] });
      expect(await gmail.outcome(action)).toEqual({ action: "cancelled", approval: "expired" });
      expect((await connection(gmail.connectionId))!.revision).toBeGreaterThan(linked.revision);
      expect(
        await failure(worker.connections.updateAccount({ ...change, connectionId: ID })),
      ).toEqual({ status: 404, message: "That connection is gone." });
      expect(
        await failure(
          worker.connections.updateAccount({ ...change, settings: { nothing: "here" } }),
        ),
      ).toMatchObject({ status: 400 });

      action = await gmail.waiting();
      await worker.connections.setEnabled({ connectionId: gmail.connectionId, enabled: false });
      expect(await gmail.outcome(action)).toEqual({ action: "cancelled", approval: "expired" });

      // The last connection out revokes the account.
      action = await gmail.waiting();
      expect(await worker.connections.remove({ connectionId: gmail.connectionId })).toEqual({
        warning: null,
      });
      expect(await gmail.outcome(action)).toMatchObject({ approval: "expired" });
      expect(accountStore.revoke).toHaveBeenCalledWith(gmail.account.id);
    });

    it("pairs a phone, pairs it again, and unpairs only the pairing asked for", async () => {
      const phone = randomUUID();
      const device = async () =>
        (await db.select().from(egressDevices).where(eq(egressDevices.id, phone)))[0]!;
      const first = await worker.egress.pairDevice({
        deviceId: phone,
        name: "Pixel 9",
        pushToken: "fcm-1",
      });
      expect(first.generation).toBe(1);
      expect((await device()).secretHash).toBe(hashDeviceSecret(first.secret));
      const second = await worker.egress.pairDevice({
        deviceId: phone,
        name: "Pixel 9",
        pushToken: "fcm-1",
      });
      expect(second).toMatchObject({ generation: 2 });
      expect(second.secret).not.toBe(first.secret);
      // A connection the first pairing still has open is dropped.
      expect(relay.revoke).toHaveBeenLastCalledWith(phone, 1);
      expect(relay.reloadPhones).toHaveBeenCalled();

      relay.reloadPhones.mockClear();
      await worker.egress.devicePushToken({ deviceId: phone, token: "fcm-1" });
      expect(relay.reloadPhones).not.toHaveBeenCalled();
      await worker.egress.devicePushToken({ deviceId: phone, token: "fcm-2" });
      expect((await device()).pushToken).toBe("fcm-2");
      expect(relay.reloadPhones).toHaveBeenCalledOnce();
      await worker.egress.deviceUsed({ deviceId: phone });
      expect((await device()).lastUsedAt).not.toBeNull();

      // A deferred revoke meant for the first pairing doesn't touch the second.
      relay.revoke.mockClear();
      await worker.egress.unpairDevice({ deviceId: phone, generation: 1 });
      expect((await device()).revokedAt).toBeNull();
      expect(relay.revoke).not.toHaveBeenCalled();
      await worker.egress.unpairDevice({ deviceId: phone, generation: 2 });
      expect(await device()).toMatchObject({ pushToken: null, revokedAt: expect.any(Date) });
      expect(relay.revoke).toHaveBeenLastCalledWith(phone, 2);
    });
  });

  describe("chat and run writes", () => {
    it("starts direct and group chats, and renames, reads and archives them", async () => {
      const ada = await newTeammate("Ada", "researcher");
      const bea = await newTeammate("Bea", "writer");
      const { chatId } = await worker.chats.newDirect({ teammateId: ada.id });
      const [direct] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(direct).toMatchObject({ kind: "direct", title: "Ada", titled: false });
      expect(await failure(worker.chats.newDirect({ teammateId: ID }))).toEqual({
        status: 404,
        message: "That teammate no longer exists.",
      });

      const group = await worker.chats.createGroup({
        title: "Launch",
        teammateIds: [ada.id, bea.id, ada.id],
      });
      const members = await db
        .select({ teammateId: chatMembers.botId }) // vocabulary: allow
        .from(chatMembers)
        .where(eq(chatMembers.chatId, group.chatId));
      expect(members.map((m) => m.teammateId).sort()).toEqual([ada.id, bea.id].sort());
      expect(
        await failure(worker.chats.createGroup({ title: "Solo", teammateIds: [ada.id, ada.id] })),
      ).toEqual({ status: 400, message: "Pick at least two teammates." });
      expect(
        await failure(worker.chats.createGroup({ title: "Ghost", teammateIds: [ada.id, ID] })),
      ).toEqual({ status: 404, message: "One of those teammates no longer exists." });

      await worker.chats.rename({ chatId, title: "Research" });
      await worker.chats.markRead({ chatId });
      await worker.chats.archive({ chatId });
      const [changed] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(changed).toMatchObject({ title: "Research", titled: true });
      expect(changed!.readAt.getTime()).toBeGreaterThan(direct!.readAt.getTime());
      expect(changed!.archivedAt).not.toBeNull();
      for (const call of [
        () => worker.chats.rename({ chatId: ID, title: "Gone" }),
        () => worker.chats.markRead({ chatId: ID }),
        () => worker.chats.archive({ chatId: ID }),
      ])
        expect(await failure(call())).toEqual({
          status: 404,
          message: "That chat no longer exists.",
        });
    });

    it("keeps one main chat per teammate, and hands it on when it's archived", async () => {
      const ada = await newTeammate("Ada", "researcher");
      const chatTeammate = chats.botId; // vocabulary: allow
      const main = async () =>
        (
          await db
            .select({ id: chats.id })
            .from(chats)
            .where(and(eq(chatTeammate, ada.id), eq(chats.main, true)))
        ).map((row) => row.id);
      // The chat a teammate starts with is its main chat; another one isn't.
      expect(await main()).toEqual([ada.chatId]);
      const { chatId: second } = await worker.chats.newDirect({ teammateId: ada.id });
      expect(await main()).toEqual([ada.chatId]);
      expect(await mainChat(ctx, ada.id)).toBe(ada.chatId);

      await worker.chats.makeMain({ chatId: second });
      expect(await main()).toEqual([second]);
      expect(await mainChat(ctx, ada.id)).toBe(second);

      // Archiving the main chat hands the role to the most recently active direct chat.
      await worker.chats.archive({ chatId: second });
      expect(await main()).toEqual([ada.chatId]);
      expect(await failure(worker.chats.makeMain({ chatId: second }))).toEqual({
        status: 400,
        message: "That chat is archived.",
      });

      // A worker from before main chats leaves none marked: Ada still links to her direct chat.
      await db.update(chats).set({ main: false }).where(eq(chats.id, ada.chatId));
      const path = `/chats/${ada.chatId}`;
      expect((await teammates.get(ada.id)).chatPath).toBe(path);
      expect((await teammates.list()).find((row) => row.id === ada.id)?.chatPath).toBe(path);
      await db.update(chats).set({ main: true }).where(eq(chats.id, ada.chatId));

      // A main chat archived by a worker from before main chats is replaced when it's needed.
      await db.update(chats).set({ archivedAt: new Date() }).where(eq(chats.id, ada.chatId));
      const made = await mainChat(ctx, ada.id);
      expect([ada.chatId, second]).not.toContain(made);
      expect(await main()).toEqual([made]);
      const [fresh] = await db.select().from(chats).where(eq(chats.id, made));
      expect(fresh).toMatchObject({ kind: "direct", title: "Ada", archivedAt: null });

      // With no main chat open, a new direct chat becomes the main one.
      await worker.chats.archive({ chatId: made });
      expect(await main()).toEqual([]);
      const { chatId: third } = await worker.chats.newDirect({ teammateId: ada.id });
      expect(await main()).toEqual([third]);

      const bea = await newTeammate("Bea", "writer");
      const group = await worker.chats.createGroup({
        title: "Launch",
        teammateIds: [ada.id, bea.id],
      });
      expect(await failure(worker.chats.makeMain({ chatId: group.chatId }))).toEqual({
        status: 400,
        message: "Only a chat with one teammate can be its main chat.",
      });
      expect(await failure(worker.chats.makeMain({ chatId: ID }))).toEqual({
        status: 404,
        message: "That chat no longer exists.",
      });
    });

    it("archives a main chat being made while its teammate is archived", async () => {
      const ada = await newTeammate("Ada", "researcher");
      await worker.chats.archive({ chatId: ada.chatId });
      // Work arrived for Ada, and mainChat() is about to add a chat: it holds the lock and has
      // checked that Ada is still on the team.
      const making = await pool.connect();
      try {
        await making.query("begin");
        await making.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          LOCKS.mainChat(ada.id),
        ]);
        const archiving = worker.teammates.archive({ teammateId: ada.id });
        await vi.waitFor(async () => {
          const { rows } = await pool.query<{ waiting: number }>(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          expect(rows[0]!.waiting).toBe(1);
        });
        const insert = `insert into chats (kind, title, bot_id, main) values ('direct', 'Ada', $1, true) returning id`; // vocabulary: allow
        const { rows } = await making.query<{ id: string }>(insert, [ada.id]);
        await making.query("commit");
        await archiving;
        const [made] = await db.select().from(chats).where(eq(chats.id, rows[0]!.id));
        expect(made).toMatchObject({ main: false, archivedAt: expect.any(Date) });
      } finally {
        await making.query("rollback").catch(() => {});
        making.release();
      }
    });

    it("saves a sent message once, delivers it, and refuses a reused id or a file not uploaded", async () => {
      const { chatId } = await newTeammate("Cy", "analyst");
      const send = { clientId: randomUUID(), chatId, text: " Hi ", attachments: [], mentions: [] };
      const sent = await worker.chats.send(send);
      expect(sent).toMatchObject({ role: "user", text: "Hi", redoOfRunId: null });
      expect(executor.dispatchMessage).toHaveBeenLastCalledWith(sent.id);
      // A retry gets the same message, and asks for delivery again.
      executor.dispatchMessage.mockClear();
      expect((await worker.chats.send(send)).id).toBe(sent.id);
      expect(executor.dispatchMessage).toHaveBeenCalledWith(sent.id);
      expect(await db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(1);
      expect(await failure(worker.chats.send({ ...send, text: "Other" }))).toEqual({
        status: 409,
        message: REUSED_ID,
      });
      // Saving is what counts: a delivery that fails is left to the reconciler.
      executor.dispatchMessage.mockRejectedValueOnce(new Error("busy"));
      const later = await worker.chats.send({ ...send, clientId: randomUUID(), text: "Later" });
      expect(later.text).toBe("Later");
      expect(ctx.log.warn).toHaveBeenCalledWith(
        "dispatch deferred to the reconciler",
        expect.objectContaining({ messageId: later.id }),
      );

      const fresh = { ...send, clientId: randomUUID() };
      expect(await failure(worker.chats.send({ ...fresh, text: " " }))).toEqual({
        status: 400,
        message: "Write a message first.",
      });
      expect(await failure(worker.chats.send({ ...fresh, chatId: ID }))).toEqual({
        status: 404,
        message: "That chat no longer exists.",
      });
      const attachment = {
        path: "/home/bot/uploads/never/notes.txt",
        name: "notes.txt",
        mime: "text/plain",
        size: 3,
      };
      expect(await failure(worker.chats.send({ ...fresh, attachments: [attachment] }))).toEqual({
        status: 400,
        message: "notes.txt didn't finish uploading. Attach it again.",
      });
      expect(await db.select().from(messages).where(eq(messages.clientId, fresh.clientId))).toEqual(
        [],
      );
    });

    it("stops and rates a run, and takes feedback once per redo id", async () => {
      const { created, run } = await teammateWithRun();
      await worker.runs.stop({ runId: run.id });
      const stopped = async () => (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
      expect((await stopped()).cancelRequestedAt).not.toBeNull();
      expect(executor.processCancellations).toHaveBeenCalled();
      await worker.runs.rate({ runId: run.id, rating: "up" });
      expect((await stopped()).rating).toBe("up");
      for (const call of [
        () => worker.runs.stop({ runId: ID }),
        () => worker.runs.rate({ runId: ID, rating: null }),
        () => worker.runs.feedback({ runId: ID, text: "No", remember: false, redo: null }),
      ])
        expect(await failure(call())).toEqual({ status: 404, message: "That reply is gone." });

      await worker.runs.feedback({
        runId: run.id,
        text: "Cite sources.",
        remember: true,
        redo: null,
      });
      expect((await stopped()).rating).toBe("down");
      const kept = await db
        .select({ content: memoryItems.content })
        .from(memoryItems)
        .where(and(eq(memoryItems.botId, created.id), eq(memoryItems.kind, "lesson"))); // vocabulary: allow
      expect(kept).toEqual([{ content: "Cite sources." }]);
      // A lesson memory refuses is the owner's to fix, not the worker's failure.
      expect(
        await failure(
          worker.runs.feedback({ runId: run.id, text: "No", remember: true, redo: null }),
        ),
      ).toMatchObject({ status: 400 });

      await worker.runs.rate({ runId: run.id, rating: null });
      const redo = { clientId: randomUUID() };
      const feedback = { runId: run.id, text: "Shorter.", remember: false, redo };
      await worker.runs.feedback(feedback);
      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.clientId, redo.clientId));
      expect(message).toMatchObject({
        chatId: created.chatId,
        text: "Shorter.",
        redoOfRunId: run.id,
        feedbackRequest: { text: "Shorter.", remember: false },
      });
      expect((await stopped()).rating).toBe("down");
      expect(executor.dispatchMessage).toHaveBeenLastCalledWith(message!.id);
      // The same feedback again delivers the saved message; other feedback with its id is refused.
      await worker.runs.feedback(feedback);
      expect(await db.select().from(messages).where(eq(messages.redoOfRunId, run.id))).toHaveLength(
        1,
      );
      expect(await failure(worker.runs.feedback({ ...feedback, text: "Longer." }))).toEqual({
        status: 409,
        message: REUSED_ID,
      });
    });
  });

  describe("teammate writes", () => {
    /** A row's teammate, under the column's legacy name. */
    const owned = (teammateId: string) => ({ botId: teammateId }); // vocabulary: allow
    /** A teammate file with this name, and these parts. */
    const file = (name: string, parts: Partial<TeammateBundle> = {}): TeammateBundle => ({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      teammate: { name, role: "Helper", instructions: "", emoji: "", autonomy: "risky" },
      skills: [],
      routines: [],
      watches: [],
      allowed: [],
      lessons: [],
      ...parts,
    });
    const imported = (name: string, parts?: Partial<TeammateBundle>) =>
      worker.teammates.import({ bundle: file(name, parts) });

    type Row = {
      id: string;
      name: string;
      slug: string;
      archived: boolean;
      lead: boolean;
      updatedAt: string;
    };
    async function team(): Promise<Row[]> {
      const { rows } = await db.execute<Row>(
        sql`select id, name, slug, archived_at is not null as archived, is_primary as lead, updated_at::text as "updatedAt" from bots`, // vocabulary: allow
      );
      return rows;
    }
    const row = async (id: string) => (await team()).find((entry) => entry.id === id)!;
    const leads = async () =>
      (await team()).filter((entry) => entry.lead).map((entry) => entry.name);

    it("imports a file: parts come along, routines and watches paused, lessons into memory", async () => {
      const atlas = await imported("Atlas", {
        skills: [{ name: "atlas-brief", description: "Brief me", instructions: "Write a brief." }],
        routines: [
          { title: "Weekly plan", prompt: "Plan the week", cron: "0 9 * * 1", quiet: false },
          { title: "Broken", prompt: "Never", cron: "not a cron", quiet: false },
        ],
        watches: [
          {
            title: "Pricing",
            prompt: "Tell me",
            url: "https://example.test/pricing",
            intervalMinutes: 60,
            lookFor: null,
          },
        ],
        allowed: [{ kind: "command", pattern: "  git   status " }],
        lessons: ["Keep answers short."],
      });
      expect(atlas).toMatchObject({ name: "Atlas", paused: 3 });
      expect(await row(atlas.teammateId)).toMatchObject({ slug: "atlas" });
      const routines = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, atlas.teammateId)); // vocabulary: allow
      // The cron it can't read is left out; the other starts paused in the owner's time zone.
      expect(routines.map((r) => [r.title, r.enabled, r.timezone])).toEqual([
        ["Weekly plan", false, "Asia/Kolkata"],
      ]);
      const watches = await db
        .select()
        .from(triggerRows)
        .where(eq(triggerRows.botId, atlas.teammateId)); // vocabulary: allow
      expect(watches.map((w) => [w.title, w.enabled])).toEqual([["Pricing", false]]);
      const exported = await worker.teammates.export({ teammateId: atlas.teammateId });
      expect(exported.slug).toBe("atlas");
      expect(exported.bundle).toMatchObject({
        skills: [{ name: "atlas-brief" }],
        allowed: [{ kind: "command", pattern: "git status" }],
        lessons: ["Keep answers short."],
      });
      // A lesson lives in memory, so the next memory change keeps it.
      await memory.addLessons(atlas.teammateId, ["Cite sources."]);
      const learned = await db
        .select({ text: lessons.text })
        .from(lessons)
        .where(eq(lessons.botId, atlas.teammateId)); // vocabulary: allow
      expect(learned.map((l) => l.text).sort()).toEqual(["Cite sources.", "Keep answers short."]);
    });

    it("keeps every rule and lesson a file carries whole, and exports what memory holds", async () => {
      // Cut short, this rule would allow every `git -C <dir>` command, not only `status`.
      const pattern = `git -C /home/bot/${"d".repeat(280)} status`;
      expect(pattern.length).toBeGreaterThan(300);
      const kit = await imported("Kit", {
        allowed: [{ kind: "command", pattern }],
        lessons: ["简洁"],
      });
      const rules = await db
        .select({ pattern: approvalRules.pattern })
        .from(approvalRules)
        .where(eq(approvalRules.botId, kit.teammateId)); // vocabulary: allow
      expect(rules).toEqual([{ pattern }]);
      // A lesson longer than a file allows, which memory holds, still exports.
      const long = `Explain it. ${"x".repeat(600)}`;
      await memory.addLessons(kit.teammateId, [long]);
      const exported = await worker.teammates.export({ teammateId: kit.teammateId });
      expect(exported.bundle.allowed).toEqual([{ kind: "command", pattern }]);
      expect([...exported.bundle.lessons].sort()).toEqual([long, "简洁"].sort());
    });

    it("adds nobody when a teammate's lessons can't be saved", async () => {
      vi.spyOn(memory, "addLessons").mockRejectedValueOnce(new Error("memory is down"));
      expect(await failure(imported("Ghost", { lessons: ["Be brief."] }))).toMatchObject({
        status: 500,
      });
      expect((await team()).filter((entry) => entry.name === "Ghost")).toEqual([]);
      const ghostChats = await db.select().from(chats).where(eq(chats.title, "Ghost"));
      expect(ghostChats).toEqual([]);
    });

    it("duplicates a teammate with its memory and reminders, and refuses one that's gone", async () => {
      const scout = await imported("Scout", {
        routines: [{ title: "Morning news", prompt: "News", cron: "0 8 * * *", quiet: false }],
        lessons: ["Prefer primary sources."],
      });
      await db.insert(scheduleRows).values({
        ...owned(scout.teammateId),
        title: "Call mom",
        prompt: "Remind me",
        kind: "once",
        runAt: new Date(Date.now() + 86_400_000),
        nextRunAt: new Date(Date.now() + 86_400_000),
        timezone: "Asia/Kolkata",
        createdBy: "user",
      });
      await memory.save(
        {
          ...owned(scout.teammateId),
          kind: "fact",
          content: "Prefers window seats",
          key: null,
          pinned: false,
          expiresAt: null,
        },
        { kind: "user" },
      );
      const copy = await worker.teammates.duplicate({
        teammateId: scout.teammateId,
        name: "Scout",
        copyMemory: true,
      });
      expect(copy.memoryCopied).toBe(true);
      expect(await row(copy.teammateId)).toMatchObject({
        name: "Scout",
        slug: "scout-2",
        lead: false,
      });
      const [chat] = await db.select().from(chats).where(eq(chats.id, copy.chatId));
      expect(chat).toMatchObject({ kind: "direct", ...owned(copy.teammateId) });
      const copied = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, copy.teammateId)); // vocabulary: allow
      expect(copied.map((r) => [r.title, r.enabled]).sort()).toEqual([
        ["Call mom", false],
        ["Morning news", false],
      ]);
      const memories = await memory.list({ ...owned(copy.teammateId) }, { kind: "user" });
      expect(memories.map((m) => m.content).sort()).toEqual([
        "Prefer primary sources.",
        "Prefers window seats",
      ]);
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ id: copy.teammateId }));
      // Without memory, no lessons either.
      const bare = await worker.teammates.duplicate({
        teammateId: scout.teammateId,
        name: "Bare",
        copyMemory: false,
      });
      expect(await memory.list({ ...owned(bare.teammateId) }, { kind: "user" })).toEqual([]);
      expect(
        await failure(
          worker.teammates.duplicate({ teammateId: ID, name: "Nobody", copyMemory: false }),
        ),
      ).toMatchObject({ status: 404 });
    });

    it("gives copies made at once different slugs", async () => {
      const echo = await imported("Original");
      const copies = await Promise.all(
        [1, 2, 3].map(() =>
          worker.teammates.duplicate({
            teammateId: echo.teammateId,
            name: "Echo",
            copyMemory: false,
          }),
        ),
      );
      const slugs = await Promise.all(copies.map(async (c) => (await row(c.teammateId)).slug));
      expect(slugs.sort()).toEqual(["echo", "echo-2", "echo-3"]);
    });

    it("makes one teammate the lead, refusing one that's gone, and touches only the two", async () => {
      const iris = await imported("Iris");
      const kit = await imported("Kit");
      const bystander = await imported("Bystander");
      const gone = await imported("Gone");
      await worker.teammates.archive({ teammateId: gone.teammateId });
      await worker.teammates.setLead({ teammateId: iris.teammateId });
      expect(await leads()).toEqual(["Iris"]);
      const before = (await row(bystander.teammateId)).updatedAt;
      await worker.teammates.setLead({ teammateId: kit.teammateId });
      await worker.teammates.setLead({ teammateId: iris.teammateId });
      expect(await leads()).toEqual(["Iris"]);
      // Only the rows that change, so other teammates keep their revisions.
      expect((await row(bystander.teammateId)).updatedAt).toBe(before);
      for (const teammateId of [gone.teammateId, ID])
        expect(await failure(worker.teammates.setLead({ teammateId }))).toEqual({
          status: 404,
          message: "That teammate no longer exists.",
        });
      expect(await leads()).toEqual(["Iris"]);
    });

    it("keeps exactly one lead when two are chosen at once", async () => {
      const juno = await imported("Juno");
      const max = await imported("Max");
      for (let round = 0; round < 10; round += 1) {
        await Promise.all([
          worker.teammates.setLead({ teammateId: juno.teammateId }),
          worker.teammates.setLead({ teammateId: max.teammateId }),
        ]);
        expect(await leads()).toHaveLength(1);
      }
    });

    it("archives a teammate: its chats, automations and work stop together", async () => {
      const { teammateId, chatId } = await imported("Retiring", {
        routines: [{ title: "Digest", prompt: "Sum up", cron: "0 18 * * *", quiet: false }],
      });
      await worker.teammates.setLead({ teammateId });
      const [run] = await db
        .insert(runs)
        .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "queued" })
        .returning({ id: runs.id });
      await db
        .update(scheduleRows)
        .set({ enabled: true })
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      await worker.teammates.archive({ teammateId });
      expect(await row(teammateId)).toMatchObject({ archived: true, lead: false });
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(chat!.archivedAt).not.toBeNull();
      const routines = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      expect(routines.map((r) => r.enabled)).toEqual([false]);
      const [stopped] = await db.select().from(runs).where(eq(runs.id, run!.id));
      expect(stopped!.cancelRequestedAt).not.toBeNull();
      expect(ctx.computer.forgetScreen).toHaveBeenLastCalledWith(teammateId);
    });

    it("archives a teammate while a memory write holds its runs, without deadlocking", async () => {
      const { teammateId, chatId } = await imported("Busy");
      await db
        .insert(runs)
        .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "running" });
      // A memory write's order (packages/memory, `changed()`): the teammate's runs, then its row.
      const memoryWrite = await pool.connect();
      try {
        await memoryWrite.query("begin");
        await memoryWrite.query(
          "update runs set cancel_requested_at = now() where bot_id = $1", // vocabulary: allow
          [teammateId],
        );
        const archiving = worker.teammates.archive({ teammateId });
        // Wait until archiving waits on a lock the memory write holds.
        for (;;) {
          const { rows } = await pool.query<{ waiting: number }>(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          if (rows[0]!.waiting > 0) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        await memoryWrite.query(
          "update bots set lessons_changed_at = now() where id = $1", // vocabulary: allow
          [teammateId],
        );
        await memoryWrite.query("commit");
        await archiving;
      } finally {
        memoryWrite.release();
      }
      expect(await row(teammateId)).toMatchObject({ archived: true });
    });

    it("sets a budget in dollars, refusing an auto-approve over it", async () => {
      const { teammateId } = await imported("Spender");
      const budget = (budget: number | null, autoApprove: number, id = teammateId) =>
        worker.teammates.setBudget({ teammateId: id, budget, autoApprove });
      expect(await failure(budget(50, 80))).toEqual({
        status: 400,
        message: "The amount to approve on its own can't be more than the budget.",
      });
      expect(await failure(budget(50, 0, ID))).toMatchObject({ status: 404 });
      await budget(120.5, 20);
      const [spender] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
      expect(spender).toMatchObject({ monthlyBudgetCents: 12_050, autoApproveCents: 2000 });
      await budget(null, 0);
      const [none] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
      expect(none!.monthlyBudgetCents).toBeNull();
    });

    it("applies suggested instructions once, and says when a suggestion went the other way", async () => {
      const { teammateId } = await imported("Writer");
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Answer in bullets.",
        reason: "Shorter",
        runId: (await teammateWithRun()).run.id,
      });
      const [waiting] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.status, "pending"),
            eq(instructionProposals.botId, teammateId),
          ),
        ); // vocabulary: allow
      await worker.proposals.accept({ proposalId: waiting!.id });
      const instructions = async () =>
        (await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId)))[0]!
          .instructions;
      expect(await instructions()).toBe("Answer in bullets.");
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ id: teammateId }));
      await worker.proposals.accept({ proposalId: waiting!.id });
      expect(await failure(worker.proposals.dismiss({ proposalId: waiting!.id }))).toEqual({
        status: 409,
        message: "That suggestion was already handled.",
      });
      // A newer suggestion dismisses the one waiting.
      const runId = (await teammateWithRun()).run.id;
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Use headings.",
        reason: "Clearer",
        runId,
      });
      const [older] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.status, "pending"),
            eq(instructionProposals.botId, teammateId),
          ),
        ); // vocabulary: allow
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Use tables.",
        reason: "Clearer",
        runId,
      });
      expect(await failure(worker.proposals.accept({ proposalId: older!.id }))).toEqual({
        status: 409,
        message: "A newer suggestion replaced this one.",
      });
      expect(await failure(worker.proposals.dismiss({ proposalId: ID }))).toMatchObject({
        status: 404,
      });
    });

    it("removes a schedule, and a schedule already gone is fine", async () => {
      const { teammateId } = await imported("Planner", {
        routines: [{ title: "Plan", prompt: "Plan", cron: "0 9 * * *", quiet: false }],
      });
      const [routine] = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      await worker.schedules.remove({ scheduleId: routine!.id });
      await worker.schedules.remove({ scheduleId: routine!.id });
      expect(await db.select().from(scheduleRows).where(eq(scheduleRows.id, routine!.id))).toEqual(
        [],
      );
    });

    // Last: it empties the team.
    it("lets only one of two teammates imported at once into an empty team lead", async () => {
      await db
        .update(teammateRows)
        .set({ archivedAt: new Date(), isPrimary: false }) // vocabulary: allow
        .where(isNull(teammateRows.archivedAt)); // vocabulary: allow
      expect(await leads()).toEqual([]);
      await Promise.all(["Ada", "Bea"].map((name) => imported(name)));
      expect(await leads()).toHaveLength(1);
    });
  });
});
