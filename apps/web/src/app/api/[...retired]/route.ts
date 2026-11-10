import { NextResponse } from "next/server";
import { isRetiredRead } from "@/lib/retired-routes";

/**
 * Only paths no other route answers get here. A read an old tab still makes gets a 401, which
 * reloads it onto current code (see `apps/web/src/lib/retired-routes.ts`); anything else is a 404.
 */
export async function GET(_request: Request, { params }: RouteContext<"/api/[...retired]">) {
  const { retired } = await params;
  if (isRetiredRead(retired))
    return NextResponse.json({ error: "This page is out of date. Reload it." }, { status: 401 });
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
