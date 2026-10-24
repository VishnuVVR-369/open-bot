import { NextResponse } from "next/server";
import { getAppState } from "@/lib/server/queries";
import { authed } from "@/lib/server/route";
import { sessionOrNull } from "@/lib/server/session";

export const GET = authed(async () => {
  const session = await sessionOrNull();
  return NextResponse.json(
    await getAppState({ name: session!.user.name, email: session!.user.email }),
  );
});
