import type { AuthProviderDefinition, IntegrationDefinition } from "./types";

export const GOOGLE_SCOPES = {
  openid: "openid",
  email: "email",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
} as const;

/** Google: your own OAuth client, and one sign-in that serves Gmail and Calendar together. */
export const GOOGLE = {
  id: "google",
  label: "Google",
  accountLabel: "Google account",
  client: "owner",
  baseScopes: [GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email],
  // Google returns `email` as the userinfo scope's full URL.
  scopeAliases: { "https://www.googleapis.com/auth/userinfo.email": GOOGLE_SCOPES.email },
  revokeHint: "Remove open-bot under Third-party access in your Google Account.",
} as const satisfies AuthProviderDefinition;

export const GMAIL = {
  kind: "gmail",
  provider: "google",
  namespace: "gmail",
  label: "Gmail",
  description: "Teammates search and read your mail, write drafts, and send them when you approve.",
  icon: "mail",
  capabilities: [
    {
      capability: "read",
      label: "Read and search mail",
      description: "Search your mailbox and read threads and attachments.",
      required: true,
      defaultOn: true,
      can: "search and read mail",
      short: "Reads mail",
      scopes: [GOOGLE_SCOPES.gmailRead],
      // gmail.modify covers reading too.
      grantedBy: [GOOGLE_SCOPES.gmailRead, GOOGLE_SCOPES.gmailModify],
    },
    {
      capability: "compose",
      label: "Write drafts and send",
      description: "Write drafts in your Gmail. Sending asks you first.",
      defaultOn: true,
      can: "write drafts, and send them (sending asks the user)",
      short: "drafts and sends",
      scopes: [GOOGLE_SCOPES.gmailCompose],
      grantedBy: [GOOGLE_SCOPES.gmailCompose, GOOGLE_SCOPES.gmailModify],
    },
    {
      capability: "organize",
      label: "Organize",
      description: "Add and remove labels, archive, and mark mail read.",
      defaultOn: false,
      can: "label, archive and mark mail read",
      short: "organizes",
      scopes: [GOOGLE_SCOPES.gmailModify],
    },
  ],
  tools: [
    { name: "search", label: "Search Gmail", capability: "read" },
    { name: "read_thread", label: "Read Gmail threads", capability: "read" },
    { name: "get_attachment", label: "Save Gmail attachments", capability: "read" },
    { name: "list_labels", label: "List Gmail labels", capability: "read" },
    { name: "create_draft", label: "Write Gmail drafts", capability: "compose" },
    { name: "update_draft", label: "Change Gmail drafts", capability: "compose" },
    { name: "send_draft", label: "Send Gmail drafts", capability: "compose" },
    { name: "organize", label: "Label and archive Gmail", capability: "organize" },
  ],
  guidance: [
    "Write mail as a Gmail draft first (gmail.create_draft), then send that draft with gmail.send_draft.",
  ],
} as const satisfies IntegrationDefinition;

export const GOOGLE_CALENDAR = {
  kind: "google_calendar",
  provider: "google",
  namespace: "calendar",
  label: "Google Calendar",
  description: "Teammates read your calendars, find free time, and plan events.",
  icon: "calendar",
  capabilities: [
    {
      capability: "read",
      label: "Read calendars",
      description: "See your calendars, events and free time.",
      required: true,
      defaultOn: true,
      can: "read calendars and find free time",
      short: "Reads events",
      scopes: [GOOGLE_SCOPES.calendarRead],
      grantedBy: [GOOGLE_SCOPES.calendarRead, GOOGLE_SCOPES.calendarEvents],
    },
    {
      capability: "write",
      label: "Create and change events",
      description: "Add and change events. Anything that emails guests asks you first.",
      defaultOn: true,
      can: "create and change events (anything that emails guests asks the user)",
      short: "changes events",
      scopes: [GOOGLE_SCOPES.calendarEvents],
    },
  ],
  tools: [
    { name: "list_calendars", label: "List calendars", capability: "read" },
    { name: "list_events", label: "List calendar events", capability: "read" },
    { name: "get_event", label: "Read calendar events", capability: "read" },
    { name: "find_free_time", label: "Find free time", capability: "read" },
    { name: "create_event", label: "Add events to your calendar", capability: "write" },
    { name: "update_event", label: "Change events on your calendar", capability: "write" },
    { name: "delete_event", label: "Delete calendar events", capability: "write" },
    { name: "respond", label: "Answer invitations", capability: "write" },
  ],
} as const satisfies IntegrationDefinition;
