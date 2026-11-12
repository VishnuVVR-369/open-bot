import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Context } from "../context";
import { toRpcError } from "../rpc/errors";
import { EmailService } from "./email";

describe("inbound email", () => {
  it("answers mail to an address that isn't one with a bare 404", async () => {
    // The email row, as the database returns it: inbound mail must carry its token.
    const row = { id: 1, inboundToken: "ours", domain: "team.example.com" };
    const db = { select: () => ({ from: () => ({ where: async () => [row] }) }) };
    const ctx = { db, events: new EventEmitter() } as unknown as Context;
    const email = new EmailService(
      ...([ctx, null, null, null] as unknown as ConstructorParameters<typeof EmailService>),
    );
    const refused = await email.inbound("not-ours", {}).catch((error: unknown) => error);
    expect(toRpcError(refused)).toMatchObject({ status: 404, message: "Not found." });
  });
});
