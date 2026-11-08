import { checkProductionSecrets } from "@/lib/server/env";
import { realtime } from "@/lib/server/realtime";

try {
  checkProductionSecrets();
} catch (error) {
  // Next.js would keep running and answer every request with an error; stop instead, so the
  // deploy fails where it's visible.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// A deploy stops this server with SIGTERM; let its tabs go so they reach the new one.
process.once("SIGTERM", () => realtime.shutdown());
