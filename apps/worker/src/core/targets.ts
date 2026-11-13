// The teammate a tool acts on, as the tools of several features take it (teammates, skills,
// automations). It lives here, not in a feature, so those features don't import each other for it.
import { z } from "zod";
import type { RunSession } from "../runs/session";
import type { Bot as Teammate } from "./db-types"; // vocabulary: allow

const TARGET_DESCRIPTION =
  "A teammate's id from list_bots. Where optional, leave it out for yourself. Changing another teammate's setup may ask the user first."; // vocabulary: allow

/** The target argument: a teammate's id, required. */
export const targetTeammate = z
  .string()
  .uuid("Use a teammate id from list_bots.") // vocabulary: allow
  .describe(TARGET_DESCRIPTION);

/** The target argument where it may be left out for the caller. */
export const optionalTarget = targetTeammate.optional();

/** A tool's arguments that name its target teammate. */
type TargetArgs = { bot_id?: string | undefined }; // vocabulary: allow

/**
 * The approval title when a tool sets up another teammate: `teammate` is their name, and
 * `automation` the quoted title of the automation the call names by id ("an automation" if none).
 */
export type SetupTitle = (names: { teammate: string; automation: string }) => string;

/**
 * The teammate a tool acts on: the one its target argument names, otherwise the caller. For
 * another teammate's setup, the user is asked first, as the caller's autonomy says. The teammates
 * feature implements it; tools of other features take this, so they don't depend on that feature.
 */
export interface TeammateTargets {
  target(session: RunSession, args: TargetArgs): Promise<Teammate>;
  setupTarget(
    session: RunSession,
    callId: string,
    tool: string,
    args: TargetArgs & { id?: string | undefined },
    title: SetupTitle,
  ): Promise<Teammate>;
}
