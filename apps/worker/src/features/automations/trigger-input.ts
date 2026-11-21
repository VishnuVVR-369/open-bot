// What a trigger may be set up with, checked before it is saved, and the error a refused request gets.
import type { TriggerInput as TriggerFormInput } from "@open-bot/api/worker";
import { teammates, connections, type Queryable } from "@open-bot/db";
import {
  invalidGmailQuery,
  integration,
  invalidLead,
  isCalendarEventFilter,
  TRIGGER_CONNECTION_KIND,
  invalidWatchUrl,
  MAX_WATCH_MINUTES,
  MIN_WATCH_MINUTES,
} from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { WorkerError } from "../../core/errors";

export class TriggerError extends WorkerError {
  constructor(message: string) {
    super(400, message);
  }
}

/** A trigger as the owner or a teammate sets it up; see `triggerInputSchema`. */
export type TriggerInput = TriggerFormInput;

/** What a trigger saves, after its input is checked. */
interface TriggerFields {
  title: string;
  prompt: string;
  url: string | null;
  intervalMinutes: number | null;
  lookFor: string | null;
  connectionId: string | null;
  query: string | null;
  leadMinutes: number | null;
}

export async function validateTrigger(db: Queryable, input: TriggerInput): Promise<TriggerFields> {
  const title = input.title.trim();
  const prompt = input.prompt.trim();
  if (!title) throw new TriggerError("Give it a name.");
  if (title.length > 80) throw new TriggerError("Keep the name under 80 characters.");
  if (!prompt) throw new TriggerError("Say what the teammate should do when it fires.");
  if (prompt.length > 4000) throw new TriggerError("Keep the instructions under 4000 characters.");
  const none = {
    url: null,
    intervalMinutes: null,
    lookFor: null,
    connectionId: null,
    query: null,
    leadMinutes: null,
  };
  if (input.kind === "webhook") return { title, prompt, ...none };
  if (input.kind === "gmail") {
    const connectionId = await checkConnection(db, input);
    const query = input.query?.trim() ?? "";
    const problem = invalidGmailQuery(query);
    if (problem) throw new TriggerError(problem);
    return { title, prompt, ...none, connectionId, query: query || null };
  }
  if (input.kind === "calendar") {
    const connectionId = await checkConnection(db, input);
    const query = input.query ?? "all";
    if (!isCalendarEventFilter(query))
      throw new TriggerError("Choose every event, or only events with other people.");
    const leadMinutes = Math.round(input.leadMinutes ?? 30);
    const problem = invalidLead(leadMinutes);
    if (problem) throw new TriggerError(problem);
    return { title, prompt, ...none, connectionId, query, leadMinutes };
  }
  const url = input.url?.trim() ?? "";
  const problem = invalidWatchUrl(url);
  if (problem) throw new TriggerError(problem);
  const intervalMinutes = Math.round(input.intervalMinutes ?? 60);
  if (intervalMinutes < MIN_WATCH_MINUTES || intervalMinutes > MAX_WATCH_MINUTES)
    throw new TriggerError(`Check between every ${MIN_WATCH_MINUTES} minutes and once a week.`);
  const lookFor = input.lookFor?.trim().slice(0, 200) || null;
  return { ...none, title, prompt, url, intervalMinutes, lookFor };
}

/** The connection a Gmail or Calendar trigger watches: on, of its kind, and the teammate's. */
async function checkConnection(db: Queryable, input: TriggerInput): Promise<string> {
  const kind = TRIGGER_CONNECTION_KIND[input.kind as "gmail" | "calendar"];
  const label = integration(kind).label;
  if (!input.connectionId) throw new TriggerError(`Choose the ${label} account to watch.`);
  const [row] = await db
    .select({
      kind: connections.kind,
      enabled: connections.enabled,
      teammateIds: connections.teammateIds,
    })
    .from(connections)
    .where(eq(connections.id, input.connectionId));
  if (!row || row.kind !== kind)
    throw new TriggerError(`That ${label} account isn't connected any more.`);
  if (!row.enabled) throw new TriggerError(`${label} is turned off in Settings → Connections.`);
  if (row.teammateIds && !row.teammateIds.includes(input.teammateId)) {
    const [teammate] = await db
      .select({ name: teammates.name })
      .from(teammates)
      .where(eq(teammates.id, input.teammateId));
    throw new TriggerError(
      `${teammate?.name ?? "This teammate"} can't use ${label}. Give them access in Settings → Connections.`,
    );
  }
  return input.connectionId;
}
