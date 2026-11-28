import type { TeammateSummary } from "@open-bot/api";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../../lib/query";
import { setLeadOptimistically } from "./optimistic";

const teammate = (id: string, isLead: boolean): TeammateSummary => ({
  id,
  name: id,
  slug: id,
  role: "Helper",
  color: "#7C5CFF",
  emoji: "",
  autonomy: "risky",
  isLead,
  directChatId: null,
  lastActiveAt: null,
  activeRun: null,
});
const team = () => [teammate("iris", true), teammate("kit", false)];
const leads = (client: QueryClient) =>
  client
    .getQueryData<TeammateSummary[]>(queryKeys.teammates)
    ?.filter((entry) => entry.isLead)
    .map((entry) => entry.id);

describe("making a teammate the lead", () => {
  it("moves the badge at once, while the write is on its way", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.teammates, team());
    let seen: string[] | undefined;
    const error = await setLeadOptimistically(client, "kit", async () => {
      seen = leads(client);
      return { error: null };
    });
    expect(error).toBeNull();
    expect(seen).toEqual(["kit"]);
    expect(leads(client)).toEqual(["kit"]);
  });

  it("puts the badge back when the write fails", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.teammates, team());
    const error = await setLeadOptimistically(client, "kit", async () => ({
      error: new Error("That teammate no longer exists."),
    }));
    expect(error).toBeInstanceOf(Error);
    expect(client.getQueryData(queryKeys.teammates)).toEqual(team());
  });

  it("puts back only the badge, keeping what else came in meanwhile", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.teammates, team());
    const error = await setLeadOptimistically(client, "kit", async () => {
      // A rename and a new teammate arrive while the write is on its way.
      client.setQueryData<TeammateSummary[]>(queryKeys.teammates, (current) => [
        ...current!.map((entry) => (entry.id === "iris" ? { ...entry, name: "Iris B" } : entry)),
        teammate("nova", false),
      ]);
      return { error: new Error("Couldn't reach open-bot.") };
    });
    expect(error).toBeInstanceOf(Error);
    expect(leads(client)).toEqual(["iris"]);
    expect(
      client.getQueryData<TeammateSummary[]>(queryKeys.teammates)?.map((entry) => entry.name),
    ).toEqual(["Iris B", "kit", "nova"]);
  });

  it("calls off a read from before the tap, so its answer can't move the badge back", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.teammates, team());
    let answer: (value: TeammateSummary[]) => void = () => {};
    const stale = client.fetchQuery({
      queryKey: queryKeys.teammates,
      queryFn: () => new Promise<TeammateSummary[]>((resolve) => (answer = resolve)),
      staleTime: 0,
    });
    await setLeadOptimistically(client, "kit", async () => {
      answer(team());
      await stale.catch(() => {});
      return { error: null };
    });
    expect(leads(client)).toEqual(["kit"]);
  });
});
