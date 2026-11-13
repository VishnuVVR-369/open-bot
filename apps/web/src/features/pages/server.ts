// Pages' server side: their API procedures, and the thumbnails and downloads the byte routes in
// `app/api/pages` serve. Server code outside this folder imports only from here; client code
// imports from `index.ts`.
import "server-only";
export { pageRoutes } from "./server/routes";
export { pageDownload, pageThumbnail } from "./server/service";
