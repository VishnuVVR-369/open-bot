import { describe, expect, it } from "vitest";
import { modelProxyToken, modelProxyUrl, workerUrlFromComputer } from "./routing";

const env = { MODEL_PROXY: true, WORKER_PORT: 4001, ENCRYPTION_KEY: "key-a" };

describe("model proxy routing", () => {
  it("reaches the worker over Railway's private network without a variable of its own", () => {
    expect(
      workerUrlFromComputer({ ...env, RAILWAY_PRIVATE_DOMAIN: "worker.railway.internal" }),
    ).toBe("http://worker.railway.internal:4001");
  });

  it("reaches a local worker from a computer container through the Docker host", () => {
    expect(workerUrlFromComputer({ ...env, WORKER_PORT: 4101 })).toBe(
      "http://host.docker.internal:4101",
    );
  });

  it("prefers an explicit address", () => {
    expect(
      workerUrlFromComputer({
        ...env,
        RAILWAY_PRIVATE_DOMAIN: "worker.railway.internal",
        MODEL_PROXY_URL: "http://10.0.0.5:4001/",
      }),
    ).toBe("http://10.0.0.5:4001");
  });

  it("gives each route its URL with the token, and none when the proxy is off", () => {
    const token = modelProxyToken("key-a");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(modelProxyToken("key-b"));
    expect(modelProxyUrl(env, "api")).toBe(
      `http://host.docker.internal:4001/model-proxy/${token}/api`,
    );
    expect(modelProxyUrl({ ...env, MODEL_PROXY: false }, "api")).toBeNull();
  });
});
