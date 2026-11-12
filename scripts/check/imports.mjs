#!/usr/bin/env node
// Keeps the import graph from tangling further (scripts/check/import-graph.mjs builds it the way
// the type checker resolves imports, `import type` included). Two rules:
//
// - No import cycles. An import from a file to another that already reaches it back joins the
//   two in a cycle, which makes neither file movable or testable on its own.
// - An app never imports another app's source (apps/worker importing apps/web/src/...). Shared
//   code lives in a package under packages/. Package imports go through each package's
//   `exports`; the `open-bot/workspace-imports` lint rule checks that (scripts/lint/).
//
// Today's cycles and cross-app imports are listed, one import per entry, in
// `imports-baseline.json`. The check fails on an import the baseline doesn't list, and on a listed
// one that is gone (run `pnpm check:imports --update`). `--update` refuses to raise either count,
// so moving a file works but a new cycle does not; `--allow-growth` is for reviewed changes only.
import { fileURLToPath } from "node:url";
import { readBaseline, repoRoot, writeBaseline } from "./baseline.mjs";
import { buildGraph, cycleGroups, importPath, isApp, workspaceOf } from "./import-graph.mjs";

export const BASELINE = "scripts/check/imports-baseline.json";

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

export function snapshot({ cycles, appImports }) {
  return { cycles: [...cycles.keys()], appImports: [...appImports.keys()] };
}

const RULES = {
  cycles: {
    describe: ({ from, to, specifier, line, back }) =>
      `${from}:${line} imports "${specifier}" (${to}), which imports it back: ${back.join(" -> ")}`,
    fix:
      "Break each cycle at one import: move what both files need into a new module that both import, " +
      "or pass it in as an argument instead of importing it. Type-only imports count too; a shared " +
      "type goes in the module that owns the data, or in a small types file both import.",
    gone: "imports in cycles",
  },
  appImports: {
    describe: ({ from, to, specifier, line, app }) =>
      `${from}:${line} imports "${specifier}" (${to}), the source of ${app}`,
    fix:
      "An app never imports another app's code. Move what both need into a package under packages/ " +
      "(or into packages/domain), export it there, and import it from both.",
    gone: "cross-app imports",
  },
};

/** Compares the graph with the baseline; returns problems for the developer to fix. */
export function compare(found, baseline) {
  const problems = [];
  for (const [name, rule] of Object.entries(RULES)) {
    const allowed = new Set(baseline[name] ?? []);
    const added = [...found[name]].filter(([entry]) => !allowed.has(entry));
    if (added.length > 0) {
      problems.push(
        [...added.map(([, details]) => rule.describe(details)), `  ${rule.fix}`].join("\n"),
      );
    }
    const gone = [...allowed].filter((entry) => !found[name].has(entry));
    if (gone.length > 0) {
      problems.push(
        `The baseline lists ${gone.length} ${rule.gone} that no longer exist (fixed, or the files moved): ` +
          `${gone.join(", ")}.\n  Run pnpm check:imports --update and commit ${BASELINE}.`,
      );
    }
  }
  return problems;
}

/** Why the baseline may not become `next`: more imports in cycles, or more cross-app imports. */
export function growth(next, baseline) {
  return ["cycles", "appImports"]
    .map((name) => [name, (baseline[name] ?? []).length, next[name].length])
    .filter(([, before, after]) => after > before)
    .map(([name, before, after]) => `${name} ${before} -> ${after}`);
}

function main(argv) {
  const root = repoRoot();
  const baseline = readBaseline(root, BASELINE, { cycles: [], appImports: [] });
  const found = analyze(buildGraph(root).edges);

  if (argv.includes("--update")) {
    const next = snapshot(found);
    const grown = growth(next, baseline);
    if (grown.length > 0 && !argv.includes("--allow-growth")) {
      process.stderr.write(
        `Not updating ${BASELINE}: it would grow (${grown.join(", ")}).\n` +
          `Run pnpm check:imports to see the new imports and fix them. Pass --allow-growth only for a reviewed change.\n`,
      );
      return 1;
    }
    writeBaseline(root, BASELINE, next);
    process.stdout.write(`Wrote ${BASELINE}. Review the diff before committing it.\n`);
    return 0;
  }

  const problems = compare(found, baseline);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  const sizes = found.groups.map((group) => group.length).join(", ");
  process.stdout.write(
    `No new import cycles or cross-app imports (baselined: ${found.groups.length} cycles of ${sizes || 0} files, ` +
      `${found.cycles.size} imports in them, ${found.appImports.size} cross-app imports).\n`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
