import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..");

/**
 * Routes that take writes without the owner's cookies, so a page on another site has nothing to
 * borrow. Every other route that takes a write goes through `crossSiteRefusal`, directly or by
 * `authed()`.
 */
const NOT_COOKIE_AUTHENTICATED: Record<string, string> = {
  "api/auth/[...all]": "Better Auth checks the origin of its own writes (trustedOrigins)",
  "api/egress/device/push-token": "the phone's device token, sent as a bearer header",
  "api/egress/device/token": "the phone's device token, sent as a bearer header",
  "api/egress/device/unavailable": "the phone's device token, sent as a bearer header",
  "api/hooks/[token]": "a webhook, authenticated by the secret in its path",
  "api/inbound/email/[token]": "the email provider, authenticated by the secret in its path",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

/** The HTTP methods a route file exports, whichever way it exports them. */
function exportedMethods(source: string): string[] {
  const single = [...source.matchAll(/export\s+(?:const|async\s+function|function)\s+(\w+)/g)];
  const destructured = [...source.matchAll(/export\s+const\s+\{([^}]*)\}/g)];
  const names = [
    ...single.map((match) => match[1]),
    ...destructured.flatMap((match) => match[1].split(",").map((name) => name.trim())),
  ];
  return names.filter((name) => /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(name));
}

const routes = routeFiles(APP).map((file) => {
  const source = readFileSync(file, "utf8");
  return {
    route: relative(APP, file).replace(/\/route\.ts$/, ""),
    methods: exportedMethods(source),
    checked: /\b(authed|crossSiteRefusal)\(/.test(source),
  };
});

describe("routes that take writes", () => {
  it("finds the routes", () => {
    expect(routes.find((r) => r.route === "api/rpc/[[...rest]]")?.methods).toEqual(["GET", "POST"]);
    expect(routes.find((r) => r.route === "api/auth/[...all]")?.methods).toEqual(["GET", "POST"]);
  });

  it("refuse other sites, unless they don't use the owner's cookies", () => {
    const unchecked = routes
      .filter((r) => r.methods.some((method) => !["GET", "HEAD", "OPTIONS"].includes(method)))
      .filter((r) => !r.checked && !(r.route in NOT_COOKIE_AUTHENTICATED))
      .map((r) => r.route);
    expect(unchecked).toEqual([]);
  });

  it("list only routes that still exist and take writes", () => {
    const writes = new Set(
      routes
        .filter((r) => r.methods.some((m) => !["GET", "HEAD", "OPTIONS"].includes(m)))
        .map((r) => r.route),
    );
    expect(Object.keys(NOT_COOKIE_AUTHENTICATED).filter((route) => !writes.has(route))).toEqual([]);
  });
});
