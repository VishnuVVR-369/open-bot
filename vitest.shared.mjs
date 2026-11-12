/**
 * Test settings every workspace package shares: each package's `vitest.config.mts` spreads
 * `sharedTest` into its `test` options (`scripts/check/vitest-config.test.mjs` checks this).
 *
 * The module cache goes in each package's own `node_modules`. Vitest's default is one directory
 * for the whole repo, and turbo runs every package's tests at once: after a lockfile change each
 * process clears that directory while the others write to it, and some fail with ENOTEMPTY.
 * The path is relative to the package, since Vitest resolves it from the package's root.
 */
export const sharedTest = {
  fsModuleCachePath: "node_modules/.vitest-cache",
};
