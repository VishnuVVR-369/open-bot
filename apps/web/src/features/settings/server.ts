// Settings' server side: their API procedures. Server code outside this folder imports only from
// here; client code imports from `index.ts`.
import "server-only";
export { settingsRoutes } from "./server/routes";
export { deviceRoute } from "./server/egress-device";
