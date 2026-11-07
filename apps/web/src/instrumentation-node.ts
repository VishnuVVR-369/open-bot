import { checkProductionSecrets } from "@/lib/server/env";

try {
  checkProductionSecrets();
} catch (error) {
  // Next.js would keep running and answer every request with an error; stop instead, so the
  // deploy fails where it's visible.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
