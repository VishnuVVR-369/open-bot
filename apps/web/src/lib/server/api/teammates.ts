import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { teammateBundleSchema } from "@open-bot/domain";
import { worker } from "../worker";
import { ApiError } from "./errors";

/**
 * The owner's changes to teammates. The worker's teammate service makes them (it owns the
 * teammate tables, see packages/db/src/owners.ts); this checks what the owner sent and passes it on.
 */

type Inputs = ApiInputs["teammates"];
type Outputs = ApiOutputs["teammates"];

/** Write the teammate's workspace now; before its next run is soon enough if the computer's away. */
export async function syncWorkspace(teammateId: string) {
  await worker.teammates.sync({ teammateId }).catch(() => {});
}

export async function createTeammate({
  profile,
  templateId,
  starterIds,
}: Inputs["create"]): Promise<Outputs["create"]> {
  return worker.teammates.create({
    ...profile,
    template_id: templateId ?? undefined,
    starter_ids: starterIds,
  });
}

export async function updateTeammate({
  teammateId,
  profile,
  revision,
}: Inputs["update"]): Promise<Outputs["update"]> {
  return worker.teammates.update({ teammateId, changes: profile, expected_revision: revision });
}

export async function duplicateTeammate({
  teammateId,
  name,
  copyMemory,
}: Inputs["duplicate"]): Promise<Outputs["duplicate"]> {
  return worker.teammates.duplicate({ teammateId, name, copyMemory });
}

/** The first thing wrong with an exported file, in words. */
function bundleProblem(file: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(file);
  } catch {
    return "This isn't an open-bot teammate file.";
  }
  const parsed = teammateBundleSchema.safeParse(json);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return issue?.path.length
    ? `The file has a problem at ${issue.path.join(".")}: ${issue.message}`
    : (issue?.message ?? "The file couldn't be read.");
}

export async function importTeammate({ file }: Inputs["import"]): Promise<Outputs["import"]> {
  const problem = bundleProblem(file);
  if (problem) throw new ApiError("BAD_REQUEST", problem);
  return worker.teammates.import({ bundle: teammateBundleSchema.parse(JSON.parse(file)) });
}

export async function setLead({ teammateId }: Inputs["setLead"]): Promise<{ ok: true }> {
  return worker.teammates.setLead({ teammateId });
}

/**
 * Archive a teammate: its chats are archived, its automations paused and its work stopped, all at
 * once. Its screen stops and its browser history goes; sign-ins stay shared with the other screens.
 */
export async function archiveTeammate({ teammateId }: Inputs["archive"]): Promise<{ ok: true }> {
  return worker.teammates.archive({ teammateId });
}

/** A teammate's monthly budget, or none so it can't pay at all, and what it may buy on its own. */
export async function setBudget(input: Inputs["setBudget"]): Promise<{ ok: true }> {
  return worker.teammates.setBudget(input);
}

/** Take a teammate's suggested instructions; they apply from its next message. */
export async function acceptProposal({
  proposalId,
}: ApiInputs["proposals"]["accept"]): Promise<{ ok: true }> {
  return worker.proposals.accept({ proposalId });
}

export async function dismissProposal({
  proposalId,
}: ApiInputs["proposals"]["dismiss"]): Promise<{ ok: true }> {
  return worker.proposals.dismiss({ proposalId });
}
