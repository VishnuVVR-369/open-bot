import { BUNDLE_FORMAT, BUNDLE_VERSION, type TeammateBundle } from "@open-bot/domain";
import { sql } from "drizzle-orm";

import type { rpcHarness } from "../../testing/rpc";

export function teammateRouteHarness({
  db,
  worker,
}: Pick<ReturnType<typeof rpcHarness>, "db" | "worker">) {
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
  const leads = async () => (await team()).filter((entry) => entry.lead).map((entry) => entry.name);
  return { owned, file, imported, team, row, leads };
}
