import { ACCOUNT_CONNECTION_KINDS, integration } from "@open-bot/domain";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_TOOL_SPECS, Integrations, isAccountNamespace, specProblem } from "./registry";
import { namespace, tool } from "./schema";
import type { IntegrationAdapter } from "./types";

const stub = (kind: IntegrationAdapter["kind"]): IntegrationAdapter => ({
  kind,
  call: vi.fn(),
  probe: vi.fn(),
  problem: (error) => error.message,
  runner: { execute: vi.fn(), reconcile: vi.fn() },
});

describe("the worker's integrations", () => {
  it("serves exactly the tools shared defines, for every integration", () => {
    expect(ACCOUNT_TOOL_SPECS.map((spec) => spec.name).sort()).toEqual(
      ACCOUNT_CONNECTION_KINDS.map((kind) => integration(kind).namespace).sort(),
    );
    for (const spec of ACCOUNT_TOOL_SPECS) {
      expect(specProblem(spec)).toBeNull();
      for (const entry of spec.tools) {
        expect(entry.deferLoading).toBe(true);
        expect(entry.inputSchema).toHaveProperty("properties.account");
      }
    }
  });

  it("says when a namespace's tools drift from their definition", () => {
    const drifted = namespace("notion", "Notion", [
      tool("search", "Search.", {}),
      tool("delete_everything", "Nope.", {}),
    ]);
    expect(specProblem(drifted)).toMatch(/missing fetch.*not defined delete_everything/);
    expect(specProblem({ ...drifted, name: "dropbox" })).toMatch(/No integration/);
  });

  it("routes only integrations' namespaces to them", () => {
    expect(isAccountNamespace("gmail")).toBe(true);
    expect(isAccountNamespace("calendar")).toBe(true);
    expect(isAccountNamespace("desktop")).toBe(false);
  });

  it("finds an action's adapter by its tool, and refuses two for one kind", () => {
    const integrations = new Integrations(ACCOUNT_CONNECTION_KINDS.map(stub));
    expect(integrations.forTool("calendar.respond")?.kind).toBe("google_calendar");
    expect(integrations.forTool("calendar.nope")).toBeUndefined();
    expect(() => new Integrations([stub("gmail"), stub("gmail")])).toThrow(/Two adapters/);
    expect(() => new Integrations([stub("gmail")]).get("notion")).toThrow(/No adapter/);
  });
});
