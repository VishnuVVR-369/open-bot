// Integrations: what teammates use outside the computer, set up in Settings. Connections (MCP
// servers), accounts (Gmail, Calendar, Notion) and email. Code outside this folder imports only
// from here, or from `server.ts` for the server side.
export { ConnectionsSection } from "./components/connections-section";
export { EmailSection } from "./components/email-section";
export { useConnections } from "./hooks";
