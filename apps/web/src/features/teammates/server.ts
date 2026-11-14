// Teammates' server side: their API procedures, the reads behind a teammate's page, and syncing a
// teammate's workspace. Server code outside this folder imports only from here; client code
// imports from `index.ts`.
import "server-only";
export { teammateRoutes } from "./server/routes";
export { getTeammatePage, nextColor, syncWorkspace, teammateName } from "./server/service";
export { listTeammates } from "./server/queries";
