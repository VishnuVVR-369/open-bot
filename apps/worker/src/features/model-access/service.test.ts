import { describe, expect, it } from "vitest";
import { modelProxyToken } from "../model-logs";
import { API_PROVIDER_ID, PLAN_PROVIDER_ID, providerFor, UnloggedApiKeyError } from "./service";

const direct = {
  OPENAI_API_BASE_URL: "https://api.openai.com/v1",
  MODEL_PROXY: false,
  WORKER_PORT: 4001,
  ENCRYPTION_KEY: "test-encryption-key",
};
const proxied = { ...direct, MODEL_PROXY: true, RAILWAY_PRIVATE_DOMAIN: "worker.railway.internal" };
const token = modelProxyToken(direct.ENCRYPTION_KEY);

describe("providerFor", () => {
  it("keeps Codex's own provider for the plan, pointed at the proxy's plan route", () => {
    const url = `http://worker.railway.internal:4001/model-proxy/${token}/plan/backend-api/codex`;
    expect(providerFor("plan", proxied)).toEqual({
      modelProvider: PLAN_PROVIDER_ID,
      config: { openai_base_url: url },
      route: url,
    });
  });

  it("sends the plan straight to ChatGPT when the proxy is off", () => {
    expect(providerFor("plan", direct)).toEqual({ modelProvider: PLAN_PROVIDER_ID });
  });

  it("points API key threads at the proxy, which adds the key, so Codex never gets it", () => {
    const provider = providerFor("api_key", proxied);
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
    expect(JSON.stringify(provider)).not.toContain("experimental_bearer_token");
  });

  it("never gives an API key thread a route around the proxy, so no key spend goes unlogged", () => {
    expect(() => providerFor("api_key", direct)).toThrow(UnloggedApiKeyError);
    // Nor in a rehearsal, whose plan leg may go straight to its stand-in.
    expect(() =>
      providerFor("api_key", { ...direct, OPEN_BOT_PLAN_BASE_URL: "http://stand-in/plan" }),
    ).toThrow(UnloggedApiKeyError);
  });

  it("routes a rehearsal's plan through the proxy to its stand-in, with a token of its own", () => {
    const provider = providerFor("plan", {
      ...proxied,
      OPEN_BOT_PLAN_BASE_URL: "http://stand-in/plan",
    });
    const url = `http://worker.railway.internal:4001/model-proxy/${token}/plan/backend-api/codex`;
    expect(provider).toEqual({
      modelProvider: "openai-plan-rehearsal",
      config: {
        "model_providers.openai-plan-rehearsal": expect.objectContaining({
          base_url: url,
          experimental_bearer_token: "plan-rehearsal",
        }),
      },
      route: url,
    });
    // The stand-in is the proxy's upstream, which only the worker calls.
    expect(JSON.stringify(provider)).not.toContain("http://stand-in/plan");
  });

  it("routes a rehearsal's plan straight to its stand-in when the proxy is off", () => {
    const provider = providerFor("plan", {
      ...direct,
      OPEN_BOT_PLAN_BASE_URL: "http://stand-in/plan",
    });
    expect(provider.route).toBeUndefined();
    expect(JSON.stringify(provider.config)).toContain("http://stand-in/plan");
  });
});
