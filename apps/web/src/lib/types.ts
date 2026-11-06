import type {
  AccountCapability,
  AccountProvider,
  AccountStatus,
  ComputerHealth,
  ConnectionKind,
  EgressModeSetting,
  RunStatus,
  TriggerKind,
} from "@open-bot/shared";

/** What the UI reads; shared by route handlers and client components. */

// The views the API serves too are defined by its contract, so the web and the phone agree.
export type {
  ActivityItem as ActivityView,
  ApprovalView,
  BotSummary,
  BriefingItem,
  ChatData,
  ChatEntry,
  ChatSummary,
  MessageView,
  NotificationView,
  PageDetail,
  PageLink,
  PageSummary,
  PageVersionView,
  RunView,
  SearchResult as SearchResultView,
  StreamRunEvent,
  TakeoverRequest as TakeoverRequestSummary,
} from "@open-bot/api";
import type { BotSummary, ChatSummary, RunView, TakeoverRequest } from "@open-bot/api";

export interface CodexStatusView {
  connected: boolean;
  authSource: "device" | "host";
  account: { type: "chatgpt" | "apiKey"; email: string | null; planType: string | null } | null;
  login: { verificationUrl: string; userCode: string } | null;
  error: string | null;
}

export interface ComputerView {
  workerOnline: boolean;
  online: boolean;
  health: ComputerHealth | null;
  egress: {
    mode: EgressModeSetting;
    agentOnline: boolean;
    computerConnected: boolean;
    stats: { openStreams: number; bytesIn: number; bytesOut: number } | null;
  };
}

/** A saved skill: reusable instructions you run with `/name`. */
export interface SkillView {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** The teammate who can use it, or null for every teammate. */
  botId: string | null;
  createdBy: "user" | "bot";
  createdByBotId: string | null;
  updatedAt: string;
}

export type SkillSummary = Omit<SkillView, "instructions">;

export interface AppState {
  user: { name: string; email: string };
  /** Your timezone, for schedules and the bots' sense of time. */
  timezone: string;
  bots: BotSummary[];
  chats: ChatSummary[];
  skills: SkillSummary[];
  computer: ComputerView;
  codex: CodexStatusView | null;
  pendingApprovals: number;
  takeoverRequests: TakeoverRequest[];
  /** Screens you have control of right now. */
  activeTakeovers: { id: string; screenId: string; startedAt: string | null }[];
  unreadNotifications: number;
  /** Teammates' suggested new instructions, waiting for you. */
  proposals: { id: string; botId: string }[];
}

/** A teammate's suggested rewrite of its instructions. */
export interface ProposalView {
  id: string;
  current: string;
  proposed: string;
  reason: string;
  createdAt: string;
}

/** Something a teammate learned from your feedback. */
export interface LessonView {
  id: string;
  text: string;
  createdAt: string;
  /** The reply it was about, to jump back to it. */
  runId: string | null;
  chatId: string | null;
}

export interface ScheduleView {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  kind: "cron" | "once";
  cron: string | null;
  runAt: string | null;
  timezone: string;
  enabled: boolean;
  /** Only tells you when there's news. */
  quiet: boolean;
  createdBy: "user" | "bot";
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRun: { id: string; status: RunStatus; chatId: string } | null;
}

/** Your Telegram bot and the account linked to it. */
export interface TelegramStatusView {
  connected: boolean;
  botUsername: string | null;
  tokenHint: string | null;
  linked: boolean;
  linkedName: string | null;
  /** Why the connection isn't working, when it isn't. */
  problem: string | null;
}

/** What every teammate knows about you. */
export interface ProfileView {
  aboutMe: string;
  updatedAt: string | null;
}

/** A page watch, a webhook, or a Gmail or Calendar trigger that wakes a teammate. */
export interface TriggerView {
  id: string;
  botId: string;
  kind: TriggerKind;
  title: string;
  prompt: string;
  enabled: boolean;
  createdBy: "user" | "bot";
  url: string | null;
  intervalMinutes: number | null;
  lookFor: string | null;
  /** Gmail and Calendar: the connection watched, and its account's address. */
  connectionId: string | null;
  account: string | null;
  /** Gmail: the search new mail must match. Calendar: `all` or `guests`. */
  query: string | null;
  /** Calendar: how many minutes before an event it wakes the teammate. */
  leadMinutes: number | null;
  /** Webhooks: the path services call, without the origin. */
  hookPath: string | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastFiredAt: string | null;
  lastRun: { id: string; status: RunStatus; chatId: string } | null;
}

/** One time a schedule, watch or webhook ran. */
export interface ScheduleRunView {
  id: string;
  chatId: string;
  status: RunStatus;
  trigger: RunView["trigger"];
  preview: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** The API key fallback, for Settings. */
export interface ModelAccessView {
  keyHint: string | null;
  capMicros: number;
  spendMicros: number;
  planLimitedUntil: string | null;
}

/** One teammate's tokens this month. */
export interface UsageView {
  botId: string | null;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** A task on the team's board. */
export interface TaskView {
  id: string;
  title: string;
  notes: string;
  status: "todo" | "doing" | "done";
  ownerBotId: string | null;
  dueOn: string | null;
  position: number;
  createdBy: "user" | "bot";
  createdByBotId: string | null;
  /** The chat where the owner was last asked to work on it. */
  chatId: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** A login or card in the vault, as the app shows it: never the secret itself. */
export interface VaultItemView {
  id: string;
  kind: "login" | "card";
  name: string;
  /** The login's site, like github.com. */
  domain: string | null;
  /** The username, or "Visa •••• 4242". */
  hint: string;
  /** The teammates that may use it, or null for every teammate. */
  botIds: string[] | null;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface PurchaseView {
  id: string;
  botId: string;
  /** The card's name and hint, while the card is still in the vault. */
  card: string | null;
  amountCents: number;
  merchant: string;
  description: string;
  status: "pending" | "approved" | "denied" | "paid" | "not_paid";
  note: string | null;
  chatId: string | null;
  runId: string | null;
  createdAt: string;
}

/** A teammate's monthly budget and what it spent of it. */
export interface SpendingView {
  budgetCents: number | null;
  autoApproveCents: number;
  spentCents: number;
  purchases: PurchaseView[];
}

/** A service teammates use through MCP, without its secrets. */
export interface ConnectionView {
  id: string;
  label: string;
  name: string;
  /** An MCP server you added, or one of your accounts. */
  kind: ConnectionKind;
  /** MCP servers only. */
  transport: "http" | "stdio" | null;
  url: string | null;
  command: string | null;
  args: string[];
  /** The header or variable names that are set, without their values. */
  secretNames: string[];
  botIds: string[] | null;
  enabled: boolean;
  updatedAt: string;
  /** Accounts only: the signed-in account, what teammates may do, and what you allowed. */
  account: AccountView | null;
  capabilities: AccountCapability[];
  /** Capabilities you picked that the provider's consent screen left out. */
  missingCapabilities: AccountCapability[];
  askBeforeActing: boolean;
  /** Accounts only: the integration's settings that are set, like Notion's teammates' area. */
  settings: ConnectionSettingView[];
}

/** One of an integration's settings on a connection: what it points at. */
export interface ConnectionSettingView {
  key: string;
  /** The provider's id for it, like a Notion page's. */
  id: string;
  title: string;
  url: string | null;
}

/** A signed-in account at an auth provider (a Google account, a Notion workspace). */
export interface AccountView {
  id: string;
  provider: AccountProvider;
  /** An email address, or the workspace's name. */
  display: string;
  status: AccountStatus;
  lastError: string | null;
  lastUsedAt: string | null;
  /** When the provider ends its grant and it must be connected again, for providers that do. */
  expiresAt: string | null;
}

/** What signing in at a provider needs. */
export interface ProviderSetupView {
  id: AccountProvider;
  label: string;
  /** `owner`: you paste a client from the provider's console; `automatic`: open-bot registers. */
  client: "owner" | "automatic";
  /** Ready for sign-ins: always, for automatic clients. */
  configured: boolean;
  /** What Settings shows of your client, without its secret. */
  hint: string | null;
  /** The address to register with the provider. */
  redirectUri: string;
}

/** What connecting accounts needs, per provider, and the accounts already signed in, to reuse. */
export interface AccountsSetupView {
  providers: ProviderSetupView[];
  accounts: AccountView[];
}

/** What connecting to a service found. */
export interface ConnectionTestView {
  ok: boolean;
  status: string | null;
  tools: { name: string; description: string }[];
  error: string | null;
}

/** Email for teammates: the domain, Postmark, and each teammate's address. */
export interface EmailStatusView {
  domain: string | null;
  /** Where Postmark should deliver inbound email, as a path on this app. */
  inboundPath: string;
  /** A safe hint of the Postmark server token, when one is saved. */
  tokenHint: string | null;
  lastReceivedAt: string | null;
  addresses: { botId: string; name: string; address: string }[];
}
