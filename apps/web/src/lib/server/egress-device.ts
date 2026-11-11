import "server-only";
import { timingSafeEqual } from "node:crypto";
import { egressDevices } from "@open-bot/db";
import { hashDeviceSecret } from "@open-bot/domain/server";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "./db";
import { WorkerError } from "./worker";

export type EgressDevice = typeof egressDevices.$inferSelect;

/**
 * Wrap a route a paired phone calls without a session: `Authorization: Bearer <secret>` and
 * `x-device-id`. An unknown, revoked or wrong credential gets `401 { error: "revoked" }`, which the
 * phone takes as final; anything else that fails is a 5xx it retries.
 */
export function deviceRoute(
  handler: (device: EgressDevice, request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const device = await authenticate(request);
      if (!device) return NextResponse.json({ error: "revoked" }, { status: 401 });
      return await handler(device, request);
    } catch (error) {
      if (error instanceof z.ZodError)
        return NextResponse.json({ error: "Invalid request." }, { status: 400 });
      const status = error instanceof WorkerError && error.status < 500 ? error.status : 503;
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status },
      );
    }
  };
}

async function authenticate(request: Request): Promise<EgressDevice | null> {
  const id = request.headers.get("x-device-id") ?? "";
  const secret = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!secret || !z.string().uuid().safeParse(id).success) return null;
  const [device] = await db
    .select()
    .from(egressDevices)
    .where(and(eq(egressDevices.id, id), isNull(egressDevices.revokedAt)));
  if (!device) return null;
  const expected = Buffer.from(device.secretHash, "hex");
  const actual = Buffer.from(hashDeviceSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? device : null;
}
