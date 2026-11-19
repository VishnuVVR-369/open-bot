import { describe, expect, it } from "vitest";
import { modelProxyToken } from "../model-logs";
import { API_PROVIDER_ID, PLAN_PROVIDER_ID, providerFor } from "./service";

const direct = {
  OPENAI_API_BASE_URL: "https://api.openai.com/v1",
  MODEL_PROXY: false,
  WORKER_PORT: 4001,
  ENCRYPTION_KEY: "test-encryption-key",
};
const proxied = { ...direct, MODEL_PROXY: true, RAILWAY_PRIVATE_DOMAIN: "worker.railway.internal" };
const token = modelProxyToken(direct.ENCRYPTION_KEY);

describe("providerFor", () => {
  it("uses Codex's own provider for the plan", () => {
    expect(providerFor("plan", null, proxied)).toEqual({ modelProvider: PLAN_PROVIDER_ID });
  });

  it("points API key threads at the proxy, which adds the key, so Codex never gets it", () => {
    const provider = providerFor("api_key", "sk-test", proxied);
    const url = `http://worker.railway.internal:4001/model-proxy/${token}/api`;
    expect(provider).toEqual({
      modelProvider: API_PROVIDER_ID,
      config: {
        [`model_providers.${API_PROVIDER_ID}`]: {
          name: "OpenAI API",
          base_url: url,
          wire_api: "responses",
        },
      },
      route: url,
    });
    expect(JSON.stringify(provider)).not.toContain("sk-test");
  });

  it("gives API key threads the key as the bearer token when the proxy is off", () => {
    const provider = providerFor("api_key", "sk-test", direct);
    expect(provider.modelProvider).toBe(API_PROVIDER_ID);
    expect(provider.route).toBeUndefined();
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
      ...proxied,
      OPEN_BOT_PLAN_BASE_URL: "http://stand-in/plan",
    });
    expect(provider.modelProvider).toBe("openai-plan-rehearsal");
    expect(JSON.stringify(provider.config)).toContain("http://stand-in/plan");
  });
});
