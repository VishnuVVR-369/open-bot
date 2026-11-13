// Home's server side: its API procedure. Server code outside this folder imports only from here;
// client code imports from `index.ts`.
import "server-only";
export { homeRoutes } from "./server/routes";
