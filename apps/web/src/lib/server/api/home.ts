import "server-only";
import type { ApiInputs, Home } from "@open-bot/api";
import { getAttention, listActivity, listFinishedSince } from "../queries";

/** Home: what needs you, what you missed since `awaySince`, and what teammates did lately. */
export async function getHome(
  user: { name: string },
  { awaySince }: ApiInputs["home"]["get"],
): Promise<Home> {
  const [attention, briefing, activity] = await Promise.all([
    getAttention(),
    awaySince ? listFinishedSince(new Date(awaySince)) : Promise.resolve([]),
    listActivity(),
  ]);
  return { ...attention, user: { name: user.name }, briefing, activity };
}
