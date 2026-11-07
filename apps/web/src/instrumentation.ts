// Runs once when a Next.js server starts, before it serves requests.
export async function register() {
  // Node-only code lives in its own file, so the Edge build never compiles it.
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
