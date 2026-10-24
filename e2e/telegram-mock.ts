import http from "node:http";

/**
 * A stand-in for the Telegram Bot API, so tests can play the user's phone. The worker talks to it
 * when started with TELEGRAM_API_BASE_URL pointing here.
 */

export const MOCK_TOKEN = "123456789:AAE2E-test-token-for-open-bot-0000000";
export const MOCK_BOT = "openbot_e2e_bot";
export const USER = { id: 424242, first_name: "Erin", username: "erin_e2e" };

export interface SentMessage {
  method: string;
  params: Record<string, unknown>;
  message_id: number;
}

export class TelegramMock {
  private server: http.Server | null = null;
  private updates: Record<string, unknown>[] = [];
  private nextUpdate = 1;
  private nextMessage = 1000;
  private waiting: (() => void)[] = [];
  readonly sent: SentMessage[] = [];

  async start(port: number) {
    this.server = http.createServer((request, response) => void this.serve(request, response));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
  }

  async stop() {
    for (const wake of this.waiting.splice(0)) wake();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private push(update: Record<string, unknown>) {
    this.updates.push({ update_id: this.nextUpdate++, ...update });
    for (const wake of this.waiting.splice(0)) wake();
  }

  /** The user (or someone else) sends the bot a message. Returns its message id. */
  say(
    text: string,
    from: { id: number; first_name: string; username?: string } = USER,
    replyTo?: number,
  ) {
    const id = this.nextMessage++;
    this.push({
      message: {
        message_id: id,
        chat: { id: from.id, type: "private" },
        from,
        text,
        date: Math.floor(Date.now() / 1000),
        ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
      },
    });
    return id;
  }

  press(data: string, messageId: number) {
    this.push({
      callback_query: {
        id: `cb${this.nextUpdate}`,
        from: USER,
        data,
        message: { message_id: messageId, chat: { id: USER.id } },
      },
    });
  }

  /** Messages the bot sent, as text. */
  texts(chatId = USER.id): string[] {
    return this.sent
      .filter((m) => m.method === "sendMessage" && m.params.chat_id === String(chatId))
      .map((m) => String(m.params.text));
  }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const params = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "");
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!match) return reply(404, { ok: false, error_code: 404, description: "Not Found" });
    const [, token, method] = match;
    if (token !== MOCK_TOKEN)
      return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });

    switch (method) {
      case "getMe":
        return reply(200, {
          ok: true,
          result: { id: 123456789, is_bot: true, first_name: "E2E bot", username: MOCK_BOT },
        });
      case "getUpdates": {
        const offset = Number(params.offset ?? 0);
        const ready = () => this.updates.filter((u) => Number(u.update_id) >= offset);
        if (ready().length === 0) {
          // Long polling, kept short so tests move quickly.
          await new Promise<void>((resolve) => {
            this.waiting.push(resolve);
            setTimeout(resolve, 1500);
          });
        }
        return reply(200, { ok: true, result: ready() });
      }
      case "sendMessage":
      case "editMessageReplyMarkup":
      case "setMessageReaction":
      case "answerCallbackQuery":
      case "deleteWebhook": {
        const message_id = this.nextMessage++;
        this.sent.push({ method, params, message_id });
        return reply(200, { ok: true, result: method === "sendMessage" ? { message_id } : true });
      }
      default:
        return reply(400, { ok: false, error_code: 400, description: `Unknown method ${method}` });
    }
  }
}
