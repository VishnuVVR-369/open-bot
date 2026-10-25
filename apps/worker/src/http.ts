import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { bots, runs, settings } from "@open-bot/db";
import { COMPUTER_PATHS, isRunActive, isScreenId, undeletablePath } from "@open-bot/shared";
import { verifyToken } from "@open-bot/shared/tokens";
import { eq, isNull } from "drizzle-orm";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { enqueueRun, publishApp, type Context } from "./context";
import type { EgressRelay } from "./egress-relay";
import { errorMessage } from "./logger";
import { sanitizeFileName, saveUpload } from "./uploads";
import type { RunExecutor } from "./runs/executor";
import type { ApprovalService } from "./services/approvals";
import type { MemoryCoordinator } from "./services/memory";
import type { ScheduleService } from "./services/schedules";
import { SkillError, type SkillService } from "./services/skills";
import type { TakeoverService } from "./services/takeovers";
import { TelegramError, type TelegramService } from "./services/telegram";
import type { PushService } from "./services/push";
import type { ConnectionService } from "./services/connections";
import { EmailError, type EmailService } from "./services/email";
import type { SwarmService } from "./services/swarms";
import { TaskError, type TaskService } from "./services/tasks";
import { TriggerError, type TriggerService } from "./services/triggers";

export interface HttpDeps {
  ctx: Context;
  executor: RunExecutor;
  approvals: ApprovalService;
  takeovers: TakeoverService;
  schedules: ScheduleService;
  skills: SkillService;
  memory: MemoryCoordinator;
  triggers: TriggerService;
  tasks: TaskService;
  push: PushService;
  swarms: SwarmService;
  connections: ConnectionService;
  email: EmailService;
  telegram: TelegramService;
  egress: EgressRelay;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 60 * 1024 * 1024;

async function readJson<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  const raw = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sameSecret(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Only files inside the computer's home folders can be read or listed. */
function safePath(path: string): string {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (!normalized.startsWith("/home/bot/") && normalized !== "/home/bot")
    throw new HttpError(400, "Path must be inside /home/bot");
  if (normalized.split("/").includes("..")) throw new HttpError(400, "Invalid path");
  if (normalized.startsWith(COMPUTER_PATHS.codexHome))
    throw new HttpError(403, "That folder is private to Codex");
  return normalized;
}

const triggerBody = z.object({
  botId: z.string().uuid(),
  kind: z.enum(["watch", "webhook"]),
  title: z.string().max(200),
  prompt: z.string().max(8000),
  url: z.string().max(2000).nullable().optional(),
  intervalMinutes: z.number().int().nullable().optional(),
  lookFor: z.string().max(400).nullable().optional(),
});

/** Turn a trigger's validation errors into 400s. */
async function triggerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TriggerError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** Turn task problems into 400s. */
async function taskCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TaskError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** Turn Telegram's errors into 400s. */
async function telegramCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TelegramError) throw new HttpError(400, error.message);
    throw error;
  }
}

export function createHttpServer(deps: HttpDeps): http.Server {
  const {
    ctx,
    executor,
    approvals,
    takeovers,
    schedules,
    skills,
    triggers,
    tasks,
    push,
    swarms,
    connections,
    email,
    telegram,
    egress,
  } = deps;
  const ok = { ok: true };

  /** A screen is a bot's, so its id must be a bot's. */
  async function screenOf(id: string): Promise<string> {
    if (!isScreenId(id)) throw new HttpError(400, "Invalid screen");
    const [bot] = await ctx.db.select({ id: bots.id }).from(bots).where(eq(bots.id, id));
    if (!bot) throw new HttpError(404, "No such teammate");
    return bot.id;
  }

  const routes: Record<
    string,
    (request: IncomingMessage, params: Record<string, string>, url: URL) => Promise<unknown>
  > = {
    "GET /internal/status": async () => ({
      computer: {
        online: ctx.computer.online,
        health: ctx.computer.health,
      },
      codex: ctx.codex.status,
      egress: egress.status,
    }),
    "POST /internal/messages/:id/dispatch": async (_request, params) => {
      await executor.dispatchMessage(params.id!);
      return ok;
    },
    "POST /internal/runs/:id/retry": async (_request, params) => {
      const [run] = await ctx.db.select().from(runs).where(eq(runs.id, params.id!));
      if (!run) throw new HttpError(404, "Run not found");
      if (isRunActive(run.status)) throw new HttpError(409, "That run is still going.");
      const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, run.botId));
      if (!bot || bot.archivedAt) throw new HttpError(409, "That teammate is archived.");
      // The same request again, in the same chat; the bot's thread still has what happened.
      const runId = await enqueueRun(ctx, {
        chatId: run.chatId,
        botId: run.botId,
        trigger: run.trigger,
        prompt: run.prompt,
        attachments: run.attachments,
        scheduleId: run.scheduleId,
      });
      await publishApp(ctx, { type: "chats" });
      return { runId };
    },
    "POST /internal/runs/cancel": async () => {
      await executor.processCancellations();
      return ok;
    },
    "POST /internal/approvals/:id/decide": async (request, params) => {
      const { decision, alwaysAllow } = await readJson(
        request,
        z.object({
          decision: z.enum(["approved", "denied"]),
          alwaysAllow: z
            .object({ pattern: z.string().max(300) })
            .nullable()
            .optional(),
        }),
      );
      if (alwaysAllow && decision === "approved") {
        const problem = await approvals.invalidRule(params.id!, alwaysAllow.pattern);
        if (problem) throw new HttpError(400, problem);
      }
      return { decided: await approvals.decide(params.id!, decision, alwaysAllow ?? undefined) };
    },
    "POST /internal/approval-rules/:id/delete": async (_request, params) => {
      await approvals.removeRule(params.id!);
      return ok;
    },
    "POST /internal/screens/:id/wake": async (_request, params) => {
      await ctx.computer.startScreen(await screenOf(params.id!));
      return ok;
    },
    "POST /internal/screens/:id/forget": async (_request, params) => {
      await ctx.computer.forgetScreen(await screenOf(params.id!));
      return ok;
    },
    "POST /internal/screens/:id/take": async (_request, params) => {
      await takeovers.take(await screenOf(params.id!));
      return ok;
    },
    "POST /internal/screens/:id/hand-back": async (request, params) => {
      const { note } = await readJson(
        request,
        z.object({ note: z.string().max(2000).nullable().optional() }),
      );
      await takeovers.handBack(await screenOf(params.id!), note ?? null);
      return ok;
    },
    "POST /internal/screens/:id/touch": async (_request, params) => {
      await ctx.computer.touchUser(await screenOf(params.id!));
      return ok;
    },
    "POST /internal/takeover/:id/dismiss": async (_request, params) => {
      await takeovers.dismiss(params.id!);
      return ok;
    },
    "POST /internal/bots/:id/sync": async (_request, params) => {
      const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, params.id!));
      if (!bot) throw new HttpError(404, "Bot not found");
      await executor.syncWorkspace(bot);
      return ok;
    },
    "GET /internal/files/list": async (_request, _params, url) => {
      const path = safePath(url.searchParams.get("path") ?? COMPUTER_PATHS.botsRoot);
      const client = await ctx.codex.ready();
      const { entries } = await client.request("fs/readDirectory", { path });
      const detailed = await Promise.all(
        entries
          .filter((entry) => !entry.fileName.startsWith("."))
          .map(async (entry) => {
            const meta = await client
              .request("fs/getMetadata", { path: `${path}/${entry.fileName}` })
              .catch(() => null);
            return {
              name: entry.fileName,
              path: `${path}/${entry.fileName}`,
              isDirectory: entry.isDirectory,
              modifiedAt: meta?.modifiedAtMs ? new Date(meta.modifiedAtMs).toISOString() : null,
            };
          }),
      );
      return { path, entries: detailed };
    },
    "GET /internal/files/read": async (_request, _params, url) => {
      const path = safePath(url.searchParams.get("path") ?? "");
      const client = await ctx.codex.ready();
      try {
        const { dataBase64 } = await client.request("fs/readFile", { path });
        return { path, dataBase64 };
      } catch (error) {
        if (/no such file|not found/i.test(String(error)))
          throw new HttpError(404, "That file isn't there anymore.");
        throw error;
      }
    },
    "POST /internal/files/write": async (request) => {
      const body = await readJson(request, z.object({ path: z.string(), dataBase64: z.string() }));
      const path = safePath(body.path);
      const client = await ctx.codex.ready();
      await client.request("fs/writeFile", { path, dataBase64: body.dataBase64 });
      return ok;
    },
    "POST /internal/files/upload": async (request) => {
      const body = await readJson(
        request,
        z.object({ name: z.string().min(1), mime: z.string(), dataBase64: z.string() }),
      );
      return saveUpload(ctx, body.name, body.dataBase64);
    },
    "POST /internal/files/put": async (request) => {
      const body = await readJson(
        request,
        z.object({ dir: z.string(), name: z.string().min(1), dataBase64: z.string() }),
      );
      const dir = safePath(body.dir);
      const client = await ctx.codex.ready();
      const { entries } = await client.request("fs/readDirectory", { path: dir });
      const taken = new Set(entries.map((entry) => entry.fileName));
      // Never overwrite: "notes.md" becomes "notes (2).md" when the name is taken.
      const name = sanitizeFileName(body.name);
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let fileName = name;
      for (let i = 2; taken.has(fileName); i += 1) fileName = `${stem} (${i})${ext}`;
      const path = `${dir}/${fileName}`;
      await client.request("fs/writeFile", { path, dataBase64: body.dataBase64 });
      return { path };
    },
    "POST /internal/files/remove": async (request) => {
      const body = await readJson(request, z.object({ path: z.string() }));
      const path = safePath(body.path);
      const active = await ctx.db
        .select({ slug: bots.slug })
        .from(bots)
        .where(isNull(bots.archivedAt));
      const problem = undeletablePath(
        path,
        active.map((bot) => bot.slug),
      );
      if (problem) throw new HttpError(403, problem);
      const client = await ctx.codex.ready();
      await client.request("fs/remove", { path, recursive: true });
      return ok;
    },
    "POST /internal/schedules": async (request) => {
      const body = await readJson(
        request,
        z.object({
          botId: z.string().uuid(),
          title: z.string().min(1).max(80),
          prompt: z.string().min(1).max(4000),
          cron: z.string().nullable(),
          at: z.string().nullable(),
          timezone: z.string().nullable(),
          quiet: z.boolean().optional(),
        }),
      );
      try {
        const schedule = await schedules.create({ ...body, createdBy: "user" });
        return { id: schedule.id };
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
    },
    "POST /internal/schedules/:id": async (request, params) => {
      const body = await readJson(
        request,
        z.object({
          botId: z.string().uuid(),
          title: z.string().min(1).max(80),
          prompt: z.string().min(1).max(4000),
          cron: z.string().nullable(),
          at: z.string().nullable(),
          timezone: z.string().nullable(),
          quiet: z.boolean().optional(),
        }),
      );
      try {
        const schedule = await schedules.update(params.id!, body);
        return { id: schedule.id };
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
    },
    "GET /internal/push": async () => ({
      publicKey: await push.publicKey(),
      devices: (await push.devices()).map((row) => ({
        endpoint: row.endpoint,
        device: row.device,
        createdAt: row.createdAt.toISOString(),
      })),
    }),
    "POST /internal/push/subscribe": async (request) => {
      const body = await readJson(
        request,
        z.object({
          subscription: z.object({
            endpoint: z.string().url().max(2000),
            keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
          }),
          device: z.string().max(200).default(""),
        }),
      );
      try {
        await push.subscribe(body.subscription, body.device);
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
      return ok;
    },
    "POST /internal/push/unsubscribe": async (request) => {
      const body = await readJson(request, z.object({ endpoint: z.string() }));
      await push.unsubscribe(body.endpoint);
      return ok;
    },
    "POST /internal/push/test": async () => ({
      sent: await push.sendAll({
        title: "open-bot",
        body: "Notifications work on this device.",
        url: "/settings#notifications",
        tag: "push-test",
      }),
    }),
    "POST /internal/tasks": async (request) => {
      const body = await readJson(
        request,
        z.object({
          title: z.string(),
          notes: z.string().optional(),
          ownerBotId: z.string().uuid().nullable().optional(),
          dueOn: z.string().nullable().optional(),
        }),
      );
      const task = await taskCall(() => tasks.create({ ...body, createdBy: "user" }));
      return { id: task.id };
    },
    "POST /internal/tasks/:id": async (request, params) => {
      const body = await readJson(
        request,
        z.object({
          title: z.string().optional(),
          notes: z.string().optional(),
          status: z.enum(["todo", "doing", "done"]).optional(),
          ownerBotId: z.string().uuid().nullable().optional(),
          dueOn: z.string().nullable().optional(),
          position: z.number().finite().optional(),
        }),
      );
      await taskCall(() => tasks.update(params.id!, body));
      return ok;
    },
    "POST /internal/tasks/:id/delete": async (_request, params) => {
      await tasks.remove(params.id!);
      return ok;
    },
    "POST /internal/tasks/:id/start": async (_request, params) => {
      const task = await taskCall(() => tasks.start(params.id!, null));
      return { chatId: task.chatId };
    },
    "POST /internal/schedules/:id/enabled": async (request, params) => {
      const body = await readJson(request, z.object({ enabled: z.boolean() }));
      try {
        await schedules.setEnabled(params.id!, body.enabled);
        return ok;
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
    },
    "POST /internal/email/inbound/:token": async (request, params) => {
      const payload = await readJson(request, z.unknown());
      try {
        return { ok: true, ...(await email.inbound(params.token!, payload)) };
      } catch (error) {
        if (error instanceof EmailError) throw new HttpError(404, "Not found.");
        throw error;
      }
    },
    "POST /internal/connections/:id/test": async (_request, params) => {
      if (!/^[0-9a-f-]{36}$/i.test(params.id!)) throw new HttpError(404, "No such connection.");
      return connections.test(params.id!);
    },
    "POST /internal/swarms/:id/stop": async (_request, params) => {
      if (!/^[0-9a-f-]{36}$/i.test(params.id!)) throw new HttpError(404, "No such swarm.");
      await swarms.stop(params.id!);
      return ok;
    },
    "POST /internal/schedules/:id/run": async (_request, params) => {
      await schedules.runNow(params.id!);
      return ok;
    },
    "POST /internal/triggers": async (request) => {
      const body = await readJson(request, triggerBody);
      const row = await triggerCall(() => triggers.create(body, { kind: "user" }));
      return { id: row.id, hookPath: row.token ? `/api/hooks/${row.token}` : null };
    },
    "POST /internal/triggers/:id": async (request, params) => {
      const body = await readJson(request, triggerBody);
      return { id: (await triggerCall(() => triggers.update(params.id!, body))).id };
    },
    "POST /internal/triggers/:id/enabled": async (request, params) => {
      const { enabled } = await readJson(request, z.object({ enabled: z.boolean() }));
      await triggerCall(() => triggers.setEnabled(params.id!, enabled));
      return ok;
    },
    "POST /internal/triggers/:id/delete": async (_request, params) => {
      await triggers.remove(params.id!);
      return ok;
    },
    "POST /internal/triggers/:id/check": async (_request, params) =>
      triggerCall(() => triggers.checkNow(params.id!)),
    "POST /internal/triggers/:id/rotate": async (_request, params) => ({
      token: await triggerCall(() => triggers.rotateToken(params.id!)),
    }),
    "POST /internal/hooks/:token": async (request, params) => {
      const body = await readJson(
        request,
        z.object({
          method: z.string().max(10),
          contentType: z.string().max(200),
          body: z.string().max(512 * 1024),
          query: z.string().max(4000),
        }),
      );
      const result = await triggers.fireWebhook(params.token!, body);
      if ("error" in result) throw new HttpError(result.status, result.error);
      return result;
    },
    "GET /internal/telegram": async () => telegram.status(),
    "POST /internal/telegram/connect": async (request) => {
      const { token } = await readJson(request, z.object({ token: z.string().max(200) }));
      return telegramCall(() => telegram.connect(token));
    },
    "POST /internal/telegram/link-code": async () => telegramCall(() => telegram.linkCode()),
    "POST /internal/telegram/test": async () => {
      await telegramCall(() => telegram.sendTest());
      return ok;
    },
    "POST /internal/telegram/unlink": async () => {
      await telegram.unlink();
      return ok;
    },
    "POST /internal/telegram/disconnect": async () => {
      await telegram.disconnect();
      return ok;
    },
    "POST /internal/skills": async (request) => {
      const body = await readJson(
        request,
        z.object({
          id: z.string().uuid().nullable().optional(),
          name: z.string(),
          description: z.string(),
          instructions: z.string(),
          botId: z.string().uuid().nullable(),
        }),
      );
      try {
        const skill = await skills.save(body, { kind: "user" }, body.id ?? undefined);
        return { id: skill.id };
      } catch (error) {
        if (error instanceof SkillError) throw new HttpError(400, error.message);
        throw error;
      }
    },
    "POST /internal/skills/:id/delete": async (_request, params) => {
      await skills.remove(params.id!);
      return ok;
    },
    "POST /internal/codex/device-login": async () => ctx.codex.startDeviceLogin(),
    "POST /internal/codex/auth-source": async (request) => {
      const { source } = await readJson(request, z.object({ source: z.enum(["device", "host"]) }));
      await ctx.db
        .insert(settings)
        .values({ id: 1, chatgptAuthSource: source })
        .onConflictDoUpdate({ target: settings.id, set: { chatgptAuthSource: source } });
      if (source === "device") await ctx.codex.logout().catch(() => {});
      const status = await ctx.codex.reauthenticate();
      await publishApp(ctx, { type: "auth" });
      return status;
    },
    "POST /internal/codex/logout": async () => {
      await ctx.codex.logout();
      await publishApp(ctx, { type: "auth" });
      return ok;
    },
    "GET /internal/codex/rate-limits": async () => ({ rateLimits: await ctx.codex.rateLimits() }),
    "POST /internal/egress/mode": async (request) => {
      const { mode } = await readJson(
        request,
        z.object({ mode: z.enum(["off", "prefer", "require"]) }),
      );
      await egress.setMode(mode);
      return ok;
    },
  };

  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(" ") as [string, string];
    const names: string[] = [];
    const regex = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, name: string) => {
        names.push(name);
        return "([^/]+)";
      })}$`,
    );
    return { method, regex, names, handler };
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://worker");
    if (url.pathname === "/healthz") {
      send(response, 200, { ok: true });
      return;
    }
    if (
      !sameSecret(request.headers["x-worker-secret"] as string | undefined, ctx.env.WORKER_SECRET)
    ) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    for (const route of compiled) {
      if (route.method !== request.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        route.names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]),
      );
      try {
        send(response, 200, await route.handler(request, params, url));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status >= 500)
          ctx.log.error("request failed", { path: url.pathname, error: errorMessage(error) });
        send(response, status, { error: errorMessage(error) });
      }
      return;
    }
    send(response, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://worker");
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname === "/vnc") {
      const mode = url.searchParams.get("mode") === "control" ? "control" : "view";
      const screen = url.searchParams.get("screen");
      if (!verifyToken(token, "vnc", ctx.env.WORKER_SECRET)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      if (!isScreenId(screen)) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      if (mode === "control" && ctx.computer.lease(screen)?.kind !== "user") {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => proxyVnc(client, ctx, screen, mode));
      return;
    }
    if (url.pathname === "/egress/agent") {
      if (!verifyToken(token, "egress", ctx.env.WORKER_SECRET)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => egress.attachAgent(client));
      return;
    }
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });

  return server;
}

/** Proxy a browser's noVNC connection to a screen's view-only or control VNC server. */
function proxyVnc(client: WebSocket, ctx: Context, screen: string, mode: "view" | "control") {
  const upstream = new WebSocket(ctx.computer.wsUrl("/vnc", { screen, mode }), {
    perMessageDeflate: false,
  });
  const pending: Buffer[] = [];
  upstream.on("open", () => {
    for (const chunk of pending) upstream.send(chunk);
    pending.length = 0;
  });
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
  });
  upstream.on("close", (code, reason) => {
    const forwardable = code === 1000 || (code >= 3000 && code <= 4999);
    client.close(forwardable ? code : 1011, reason);
  });
  upstream.on("error", () => client.close(1011, "The computer's desktop is not reachable"));
  client.on("message", (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(chunk);
    else pending.push(chunk);
  });
  client.on("close", () => upstream.close());
}
