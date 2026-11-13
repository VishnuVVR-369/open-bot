import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

/** Features may compose each other; shared infrastructure must stay independent of them. */
function boundaryIssue(file: string, specifier: string): string | null {
  const target = specifier.startsWith("@/")
    ? specifier.slice(2)
    : specifier.startsWith(".")
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : null;
  if (!target) return null;
  if (file.startsWith("features/") && target.startsWith("app/")) return "feature imports a route";
  if (/^(lib|components|theme|computer)\//.test(file) && /^(features|app)\//.test(target))
    return "shared infrastructure imports a feature or route";
  return null;
}

describe("mobile feature boundaries", () => {
  it("keeps feature composition out of shared infrastructure and routes out of features", () => {
    const problems: string[] = [];
    for (const file of files(root).filter((file) => !file.endsWith(".test.ts"))) {
      const relative = path.relative(root, file);
      const tree = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const check = (specifier: ts.Node | undefined) => {
        if (!specifier || !ts.isStringLiteralLike(specifier)) return;
        const issue = boundaryIssue(relative, specifier.text);
        if (issue) problems.push(`${relative}: ${specifier.text}: ${issue}`);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          check(node.moduleSpecifier);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          check(node.arguments[0]);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
          check(node.argument.literal);
        ts.forEachChild(node, visit);
      };
      visit(tree);
      if (relative.startsWith("app/") && !/\/(?:_layout|\+[^/]+)\.tsx$/.test(relative)) {
        const [entry] = tree.statements;
        if (
          tree.statements.length !== 1 ||
          !entry ||
          !ts.isExportDeclaration(entry) ||
          !entry.moduleSpecifier ||
          !ts.isStringLiteral(entry.moduleSpecifier) ||
          !entry.moduleSpecifier.text.startsWith("@/features/") ||
          !entry.exportClause ||
          !ts.isNamedExports(entry.exportClause) ||
          entry.exportClause.elements.length !== 1 ||
          entry.exportClause.elements[0]?.name.text !== "default"
        )
          problems.push(`${relative}: route must re-export its feature screen`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("rejects upward alias and relative imports while allowing feature composition", () => {
    expect(boundaryIssue("lib/query.ts", "@/features/chat/hooks")).toBeTruthy();
    expect(boundaryIssue("components/button.tsx", "../features/chat/hooks")).toBeTruthy();
    expect(boundaryIssue("features/chat/hooks.ts", "../../app/search")).toBeTruthy();
    expect(boundaryIssue("features/chat/hooks.ts", "@/lib/query")).toBeNull();
    expect(boundaryIssue("features/home/hooks.ts", "@/features/chat/hooks")).toBeNull();
    expect(boundaryIssue("lib/query.ts", "@open-bot/api")).toBeNull();
  });
});
