import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
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

const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Each HTTP method a route file exports, however it's exported, and whether that handler refuses
 * other sites: it's `authed(...)`, or a function that calls `crossSiteRefusal`, or a name for one
 * declared in the same file. Anything else, like a handler imported from elsewhere, counts as not.
 */
function handlers(source: string): { method: string; checked: boolean }[] {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const locals = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      locals.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          locals.set(declaration.name.text, declaration.initializer);
  }

  const callsRefusal = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "crossSiteRefusal") ||
    (ts.forEachChild(node, (child) => callsRefusal(child) || undefined) ?? false);

  const checked = (node: ts.Node | undefined, seen = new Set<string>()): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      return checked(locals.get(node.text), new Set(seen).add(node.text));
    }
    if (ts.isCallExpression(node))
      return ts.isIdentifier(node.expression) && node.expression.text === "authed";
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
      return node.body !== undefined && callsRefusal(node.body);
    return false;
  };

  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const found: { method: string; checked: boolean }[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement))
      found.push({ method: statement.name.text, checked: checked(statement) });
    if (ts.isVariableStatement(statement) && exported(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          found.push({ method: declaration.name.text, checked: checked(declaration.initializer) });
        // `export const { GET, POST } = handler`: whatever made them, it isn't a check here.
        if (ts.isObjectBindingPattern(declaration.name))
          for (const element of declaration.name.elements)
            if (ts.isIdentifier(element.name))
              found.push({ method: element.name.text, checked: false });
      }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        found.push({
          method: element.name.text,
          // `export { x } from "./elsewhere"` can't be seen from here.
          checked: !statement.moduleSpecifier && checked(element.propertyName ?? element.name),
        });
  }
  return found.filter((handler) => METHODS.has(handler.method));
}

/** The write methods a route file exports without refusing other sites. */
function uncheckedWrites(source: string): string[] {
  return handlers(source)
    .filter((handler) => !SAFE.has(handler.method) && !handler.checked)
    .map((handler) => handler.method);
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const routes = routeFiles(APP).map((file) => {
  const source = readFileSync(file, "utf8");
  return {
    route: relative(APP, file).replace(/\/route\.ts$/, ""),
    methods: handlers(source).map((handler) => handler.method),
    unchecked: uncheckedWrites(source),
  };
});

describe("telling checked writes from unchecked ones", () => {
  it("checks each handler on its own, not the file", () => {
    const source = `
      export const GET = authed(read);
      export const POST = write;`;
    expect(uncheckedWrites(source)).toEqual(["POST"]);
  });

  it("sees writes exported under another name", () => {
    expect(
      uncheckedWrites(`const write = async () => new Response(); export { write as POST };`),
    ).toEqual(["POST"]);
    expect(uncheckedWrites(`export { POST } from "./elsewhere";`)).toEqual(["POST"]);
  });

  it("counts authed() and a crossSiteRefusal call, through local names", () => {
    const source = `
      async function handle(request) {
        const refused = crossSiteRefusal(request);
        if (refused) return refused;
        return new Response();
      }
      const guarded = handle;
      export const POST = guarded;
      export { handle as PATCH };
      export const PUT = authed(async (request) => new Response());
      export async function DELETE(request) { return new Response(); }`;
    expect(uncheckedWrites(source)).toEqual(["DELETE"]);
  });
});

describe("routes that take writes", () => {
  it("finds the routes", () => {
    expect(routes.find((r) => r.route === "api/rpc/[[...rest]]")?.methods).toEqual(["GET", "POST"]);
    expect(routes.find((r) => r.route === "api/auth/[...all]")?.methods).toEqual(["GET", "POST"]);
  });

  it("refuse other sites, unless they don't use the owner's cookies", () => {
    const unchecked = routes
      .filter((r) => r.unchecked.length > 0 && !(r.route in NOT_COOKIE_AUTHENTICATED))
      .map((r) => `${r.route}: ${r.unchecked.join(", ")}`);
    expect(unchecked).toEqual([]);
  });

  it("list only routes that still exist and take writes", () => {
    const writes = new Set(
      routes.filter((r) => r.methods.some((m) => !SAFE.has(m))).map((r) => r.route),
    );
    expect(Object.keys(NOT_COOKIE_AUTHENTICATED).filter((route) => !writes.has(route))).toEqual([]);
  });
});
