import type {
  ApprovalKind,
  Autonomy,
  ComputerHealth,
  EgressModeSetting,
  RunEventPayload,
  RunStatus,
  RunTimelineState,
  SwarmTaskState,
} from "@open-bot/shared";

import type { ChatKind, RunTrigger } from "@open-bot/db";

/** What the UI reads; shared by route handlers and client components. */

export interface BotSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  color: string;
  emoji: string;
  autonomy: Autonomy;
  isPrimary: boolean;
  /** The bot's direct chat. */
  directChatId: string | null;
  activeRun: {
    id: string;
    chatId: string;
    status: RunStatus;
    waitingFor: "approval" | "takeover" | null;
  } | null;
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  botId: string | null;
  memberIds: string[];
  lastActivityAt: string;
  active: boolean;
}

export interface TakeoverRequestSummary {
  id: string;
  /** The screen to take over: the requesting bot's. */
  screenId: string;
  botId: string | null;
  botName: string;
  reason: string;
  chatId: string | null;
  createdAt: string;
}

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
  takeoverRequests: TakeoverRequestSummary[];
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

export interface MessageView {
  id: string;
  role: "user" | "system";
  text: string;
  attachments: { name: string; path: string; mime: string; size: number }[];
  mentions: string[];
  steeredRunId: string | null;
  /** Your feedback on this reply, asking the teammate to do it again. */
  redoOfRunId: string | null;
  createdAt: string;
}

export interface RunView {
  id: string;
  botId: string;
  trigger: RunTrigger;
  messageId: string | null;
  parentRunId: string | null;
  /** For handoffs, questions and answers: the teammate this run came from. */
  fromBotId: string | null;
  /** How the run reached the model; null before it started. */
  authMode: "plan" | "api_key" | null;
  scheduleTitle: string | null;
  /** The watch or webhook that started the run. */
  triggerTitle: string | null;
  /** For runs an automation started: what the teammate was given. */
  automationPrompt: string | null;
  /** Your thumbs up or down on the reply. */
  rating: "up" | "down" | null;
  /** Tokens and cost of the run, once the model reported them. */
  usage: { tokens: number; costMicros: number } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  timeline: RunTimelineState;
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

export type ChatEntry =
  { type: "message"; at: string; message: MessageView } | { type: "run"; at: string; run: RunView };

export interface ChatData {
  chat: ChatSummary;
  members: BotSummary[];
  entries: ChatEntry[];
  /** The id of the last run event included. Stream from here. */
  cursor: number;
  hasMore: boolean;
  /** For a swarm helper's chat: the screen it works on and the swarm it's part of. */
  helper: {
    screenId: string;
    state: SwarmTaskState;
    swarmTitle: string;
    swarmChatId: string;
    swarmRunId: string;
  } | null;
}

export interface StreamRunEvent {
  id: number;
  runId: string;
  payload: RunEventPayload;
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  botId: string | null;
  chatId: string | null;
  runId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ApprovalView {
  id: string;
  runId: string;
  botId: string;
  chatId: string;
  kind: ApprovalKind;
  /** The raw command, for command approvals. */
  subject: string | null;
  title: string;
  detail: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  decidedAt: string | null;
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

/** A page watch or a webhook that wakes a teammate. */
export interface TriggerView {
  id: string;
  botId: string;
  kind: "watch" | "webhook";
  title: string;
  prompt: string;
  enabled: boolean;
  createdBy: "user" | "bot";
  url: string | null;
  intervalMinutes: number | null;
  lookFor: string | null;
  /** Webhooks: the path services call, without the origin. */
  hookPath: string | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastFiredAt: string | null;
  lastRun: { id: string; status: RunStatus; chatId: string } | null;
}

/** A message or a teammate's reply that matched a search. */
export interface SearchResultView {
  id: string;
  /** "you" for your messages, "bot" for a teammate's reply. */
  from: "you" | "bot";
  chatId: string;
  runId: string | null;
  botId: string | null;
  /** The part of the text around the match. */
  excerpt: string;
  createdAt: string;
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

export interface ActivityView {
  runId: string;
  chatId: string;
  chatKind: ChatKind;
  chatTitle: string;
  botId: string;
  trigger: RunView["trigger"];
  status: RunStatus;
  preview: string | null;
  createdAt: string;
}

/** Something a teammate finished while you were away. */
export interface BriefingItem extends ActivityView {
  completedAt: string;
  /** The schedule, watch or webhook that started it. */
  automationTitle: string | null;
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
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  /** The header or variable names that are set, without their values. */
  secretNames: string[];
  botIds: string[] | null;
  enabled: boolean;
  updatedAt: string;
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
