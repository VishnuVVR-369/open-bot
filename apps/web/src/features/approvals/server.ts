// Approvals' server side: their API procedures. Server code outside this folder imports only
// from here; client code imports from `index.ts`.
import "server-only";
export { approvalRoutes } from "./server/routes";
