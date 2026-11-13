// The vault's server side: its API procedures. Server code outside this folder imports only
// from here; client code imports from `index.ts`.
import "server-only";
export { vaultRoutes } from "./server/routes";
