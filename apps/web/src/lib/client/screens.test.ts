import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/types";
import { orpc } from "./rpc";
import { releaseScreenNow } from "./screens";

const SCREEN = "7d1e2c3b-4a5f-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** Only the parts of the app state a hand back touches. */
const state = {
  activeTakeovers: [{ screenId: SCREEN }, { screenId: OTHER }],
  computer: {
    health: {
      screens: [
        { id: SCREEN, lease: { kind: "user" } },
        { id: OTHER, lease: { kind: "user" } },
      ],
    },
  },
} as unknown as AppState;

describe("handing a screen back", () => {
  it("lets go of it in the state the app shows, before the server answers", async () => {
    const client = new QueryClient();
    client.setQueryData(orpc.app.state.queryKey(), state);
    await releaseScreenNow(client, SCREEN);
    const shown = client.getQueryData<AppState>(orpc.app.state.queryKey())!;
    expect(shown.activeTakeovers.map((t) => t.screenId)).toEqual([OTHER]);
    expect(shown.computer.health!.screens.map((s) => s.lease)).toEqual([null, { kind: "user" }]);
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });
});
