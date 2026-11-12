// Runs once when a Next.js server starts, before it serves requests.
export async function register() {
  // Node-only code lives in its own file, so the Edge build never compiles it. Next.js replaces
  // this literal read at build time, which is what drops the import from the Edge bundle.
  // eslint-disable-next-line no-restricted-properties
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
