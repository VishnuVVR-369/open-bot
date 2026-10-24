import { describe, expect, it } from "vitest";
import { API_PROVIDER_ID, PLAN_PROVIDER_ID, providerFor } from "./model-access";

const env = { OPENAI_API_BASE_URL: "https://api.openai.com/v1" };

describe("providerFor", () => {
  it("uses Codex's own provider for the plan", () => {
    expect(providerFor("plan", null, env)).toEqual({ modelProvider: PLAN_PROVIDER_ID });
  });

  it("gives API key threads their own provider with the key as the bearer token", () => {
    const provider = providerFor("api_key", "sk-test", env);
    expect(provider.modelProvider).toBe(API_PROVIDER_ID);
    expect(provider.config).toEqual({
      [`model_providers.${API_PROVIDER_ID}`]: expect.objectContaining({
        base_url: "https://api.openai.com/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-test",
      }),
    });
  });

  it("routes plan traffic to a rehearsal endpoint only when one is configured", () => {
    const provider = providerFor("plan", null, {
      ...env,
      OPEN_BOT_PLAN_BASE_URL: "http://mock/plan",
    });
    expect(provider.modelProvider).toBe("openai-plan-rehearsal");
    expect(JSON.stringify(provider.config)).toContain("http://mock/plan");
  });
});
