// The Railway project, as code. Railway doesn't read this file during deploys: changes take
// effect when someone runs `railway config apply` (see README.md next to it).
import { defineRailway, github, image, project, service, volume } from "railway/iac";

import { watchPatterns } from "./watch-paths.ts";

export default defineRailway(() => {
  const openBot = github("VishnuVVR-369/open-bot", { branch: "main", checkSuites: false });

  const computerVolume = volume("computer-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 5000,
  });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 5000,
  });
  const web = service("web", {
    source: openBot,
    build: {
      buildCommand: "pnpm --filter @open-bot/web build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: watchPatterns("web"),
    },
    start: "pnpm --filter @open-bot/web start",
    healthcheck: "/api/auth/ok",
    replicas: { sfo: 1 },
    deploy: {
      limitOverride: { containers: { cpu: 4, memoryBytes: 4000000000 } },
      sleepApplication: true,
    },
  });
  const computer = service("computer", {
    source: openBot,
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "images/computer/Dockerfile",
      watchPatterns: watchPatterns("computer"),
    },
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    replicas: { sfo: 1 },
    deploy: { drainingSeconds: 30, sleepApplication: true },
    volumeMounts: { "/home": computerVolume },
  });
  const pages = service("pages", {
    source: openBot,
    build: {
      buildCommand: "pnpm --filter @open-bot/pages build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: watchPatterns("pages"),
    },
    start: "pnpm --filter @open-bot/pages start",
    healthcheck: "/healthz",
    replicas: { sfo: 1 },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 2000000000 } },
      sleepApplication: true,
    },
  });
  const Postgres = service("Postgres", {
    source: image("pgvector/pgvector:pg17"),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    replicas: { sfo: 1 },
    deploy: { limitOverride: { containers: { cpu: 2, memoryBytes: 2000000000 } } },
    networking: { privateNetworkEndpoint: "postgres" },
    volumeMounts: { "/var/lib/postgresql/data": postgresVolume },
  });
  const worker = service("worker", {
    source: openBot,
    build: {
      buildCommand: "pnpm --filter @open-bot/worker build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: watchPatterns("worker"),
    },
    start: "pnpm --filter @open-bot/worker start",
    healthcheck: "/healthz",
    preDeploy: "pnpm db:migrate",
    replicas: { sfo: 1 },
    deploy: { drainingSeconds: 30 },
  });

  return project("open-bot", {
    // Variables stay on Railway and this file never reads or writes them. The CLI honors this,
    // but the SDK's types don't declare it yet; drop the directive once they do.
    // @ts-expect-error -- `variables` is missing from ProjectDefinition in railway 3.16.0.
    variables: { managed: false },
    resources: [web, computer, pages, Postgres, worker, computerVolume, postgresVolume],
  });
});
