#!/usr/bin/env node
// Keeps the import graph untangled (scripts/check/import-graph.mjs builds it the way the type
// checker resolves imports, `import type` included). Two rules, both with no baseline:
//
// - No import cycles. An import from a file to another that already reaches it back joins the
//   two in a cycle, which makes neither file movable or testable on its own.
// - An app never imports another app's source (apps/worker importing apps/web/src/...). Shared
//   code lives in a package under packages/. Package imports go through each package's
//   `exports`; the `open-bot/workspace-imports` lint rule checks that (scripts/lint/).
//
// The check fails on any import that breaks either rule. There is nothing to baseline or update:
// fix the import.
import { fileURLToPath } from "node:url";
import { repoRoot } from "./baseline.mjs";
import { buildGraph, cycleGroups, importPath, isApp, workspaceOf } from "./import-graph.mjs";

const key = (from, to) => `${from} -> ${to}`;

/**
 * `{ cycles, appImports, groups }`: the imports inside a cycle and the cross-app imports, each a
 * sorted map from `from -> to` to its details, and the cycles' groups of files.
 */
export function analyze(edges) {
  const groups = cycleGroups(edges);
  const groupOf = new Map();
  groups.forEach((group, i) => group.forEach((file) => groupOf.set(file, i)));
  const cycles = new Map();
  const appImports = new Map();
  for (const [from, targets] of edges) {
    for (const [to, { specifier, line }] of targets) {
      const where = { from, to, specifier, line };
      if (groupOf.has(from) && groupOf.get(from) === groupOf.get(to)) {
        cycles.set(key(from, to), { ...where, back: importPath(edges, to, from) });
      }
      const target = workspaceOf(to);
      if (isApp(target) && workspaceOf(from) !== target) {
        appImports.set(key(from, to), { ...where, app: target });
      }
    }
  }
  const sorted = (map) => new Map([...map].sort(([a], [b]) => a.localeCompare(b)));
  return { cycles: sorted(cycles), appImports: sorted(appImports), groups };
}

const RULES = {
  cycles: {
    describe: ({ from, to, specifier, line, back }) =>
      `${from}:${line} imports "${specifier}" (${to}), which imports it back: ${back.join(" -> ")}`,
    fix:
      "Break each cycle at one import: move what both files need into a new module that both import, " +
      "or pass it in as an argument instead of importing it. Type-only imports count too; a shared " +
      "type goes in the module that owns the data, or in a small types file both import.",
  },
  appImports: {
    describe: ({ from, to, specifier, line, app }) =>
      `${from}:${line} imports "${specifier}" (${to}), the source of ${app}`,
    fix:
      "An app never imports another app's code. Move what both need into a package under packages/ " +
      "(or into packages/domain), export it there, and import it from both.",
  },
};

/** Every import that breaks a rule, with how to fix it; empty when the graph is clean. */
export function problems(found) {
  return Object.entries(RULES)
    .filter(([name]) => found[name].size > 0)
    .map(([name, rule]) =>
      [...[...found[name].values()].map(rule.describe), `  ${rule.fix}`].join("\n"),
    );
}

function main() {
  const found = analyze(buildGraph(repoRoot()).edges);
  const failed = problems(found);
  if (failed.length > 0) {
    process.stderr.write(`${failed.join("\n")}\n`);
    return 1;
  }
  process.stdout.write("No import cycles or cross-app imports.\n");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
