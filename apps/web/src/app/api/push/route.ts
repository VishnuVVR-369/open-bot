import { NextResponse } from "next/server";
import { authed } from "@/lib/server/route";
import { worker } from "@/lib/server/worker";

/** The key browsers subscribe with, and the devices that get push notifications. */
export const GET = authed(async () =>
  NextResponse.json(
    await worker<{
      publicKey: string;
      devices: { endpoint: string; device: string; createdAt: string }[];
    }>("GET", "/internal/push"),
  ),
);
