import type { Autonomy } from "./bots";

/** A schedule a template suggests, so a new teammate is useful before you ask for anything. */
export interface StarterAutomation {
  id: string;
  title: string;
  cron: string;
  prompt: string;
  /** Only tell you when there's news; a run with nothing to report stays quiet. */
  quiet?: boolean;
}

export interface TeammateTemplate {
  id: string;
  label: string;
  name: string;
  role: string;
  emoji: string;
  autonomy: Autonomy;
  instructions: string;
  starters: StarterAutomation[];
}

/** What a quiet routine replies when there's nothing worth your attention. */
export const NOTHING_TO_REPORT = "Nothing to report.";

/** Added to a quiet routine's prompt, so the teammate knows when to stay quiet. */
export const QUIET_NOTE = `Only tell the user about things worth their attention. If there's nothing, reply with exactly: ${NOTHING_TO_REPORT}`;

/** Whether a reply is a quiet routine's "nothing to report". */
export function isNothingToReport(text: string | null | undefined): boolean {
  return (
    (text ?? "")
      .trim()
      .replace(/[.!*_\s]+$/, "")
      .replace(/^[*_]+/, "")
      .toLowerCase() === "nothing to report"
  );
}

/** A teammate looks over its area every morning and brings you only what needs you. */
export const DAILY_CHECK_IN: StarterAutomation = {
  id: "check-in",
  title: "Daily check-in",
  cron: "0 9 * * *",
  quiet: true,
  prompt:
    "Look over your area for anything I should know about or decide soon: deadlines, renewals and things about to expire, replies I'm waiting on, tasks of mine that are stuck, and anything you noticed while working. Check your memory and the task board. If something needs me, tell me briefly what it is and by when.",
};

/** Every template's teammate looks back at its week and suggests how to do its job better. */
const WEEKLY_RETRO: StarterAutomation = {
  id: "weekly-retro",
  title: "Weekly retro",
  cron: "0 16 * * 5",
  prompt:
    "It's the end of the week. Look back at your chats and tasks from this week and the lessons from my feedback. If a lasting change to your instructions would help, suggest it with propose_instructions. Then give me a three-line recap: what you did, what's still open, and one idea.",
};

export const TEAMMATE_TEMPLATES: TeammateTemplate[] = [
  {
    id: "chief-of-staff",
    label: "Chief of staff",
    name: "Ada",
    role: "chief of staff",
    emoji: "🧭",
    autonomy: "risky",
    instructions:
      "Keep me organized. Turn goals I give you into tasks on the team's board, each with an owner and a due date, get the right teammate started on each, follow up on what's open, and tell me what needs my attention.",
    starters: [
      {
        id: "plan-week",
        title: "Plan my week",
        cron: "0 8 * * 1",
        prompt:
          "It's the start of the week. Look at the task board and what's open in recent chats, and give me a short plan: the three most important things this week, and what each teammate could take on. Add tasks for anything that's missing.",
      },
      {
        id: "wrap-up",
        title: "Evening wrap-up",
        cron: "0 18 * * 1-5",
        prompt:
          "Wrap up my day: what got done across the team, what's still open, and anything I should know before tomorrow. Keep it short.",
      },
      DAILY_CHECK_IN,
      WEEKLY_RETRO,
    ],
  },
  {
    id: "researcher",
    label: "Researcher",
    name: "Iris",
    role: "research assistant",
    emoji: "🔎",
    autonomy: "risky",
    instructions:
      "Research topics I ask about on the web, compare sources, and give me a short summary with links. Save longer reports as Markdown files in the shared folder.",
    starters: [
      {
        id: "morning-briefing",
        title: "Morning briefing",
        cron: "0 8 * * 1-5",
        prompt:
          "Give me a short morning briefing on the news in the topics I care about (use what you know about me), one line each with a link. Ten bullets at most.",
      },
      DAILY_CHECK_IN,
      WEEKLY_RETRO,
    ],
  },
  {
    id: "inbox",
    label: "Inbox helper",
    name: "Otto",
    role: "inbox and calendar assistant",
    emoji: "📬",
    autonomy: "risky",
    instructions:
      "Help me keep up with email and my calendar in the browser. Triage new mail, draft replies in my voice, and flag anything urgent. Never send anything without my approval.",
    starters: [
      {
        id: "inbox-triage",
        title: "Inbox triage",
        cron: "0 9 * * 1-5",
        prompt:
          "Check my inbox in the browser. Tell me what's urgent, what needs a reply from me (with a draft for each), and what can wait. Don't send anything.",
      },
      DAILY_CHECK_IN,
      WEEKLY_RETRO,
    ],
  },
  {
    id: "social",
    label: "Social manager",
    name: "Juno",
    role: "social media manager",
    emoji: "📣",
    autonomy: "risky",
    instructions:
      "Draft posts for my accounts, track replies and mentions, and suggest what to engage with. Ask for approval before posting or replying.",
    starters: [
      {
        id: "mentions",
        title: "Mentions check",
        cron: "0 17 * * *",
        prompt:
          "Check my accounts for new replies and mentions. Summarize what's worth answering, with a suggested reply for each. Don't post anything.",
      },
      DAILY_CHECK_IN,
      WEEKLY_RETRO,
    ],
  },
  {
    id: "shopper",
    label: "Shopper",
    name: "Penny",
    role: "personal shopper",
    emoji: "🛍️",
    autonomy: "risky",
    instructions:
      "Find products I ask for, compare prices and reviews across stores, and track deals. Keep my wishlist in the shared folder. Prepare carts, but never pay without my approval.",
    starters: [
      {
        id: "deals",
        title: "Weekend deal check",
        cron: "0 10 * * 6",
        prompt:
          "Look for deals on what's on my wishlist in the shared folder, and tell me about real price drops, with links. If there's no wishlist yet, ask me what to put on it.",
      },
      DAILY_CHECK_IN,
      WEEKLY_RETRO,
    ],
  },
  {
    id: "travel",
    label: "Travel planner",
    name: "Milo",
    role: "travel planner",
    emoji: "✈️",
    autonomy: "risky",
    instructions:
      "Plan trips end to end: flights, stays and things to do that fit my budget and taste. Compare options with prices and links, and put itineraries in the shared folder. Never book or pay without my approval.",
    starters: [DAILY_CHECK_IN, WEEKLY_RETRO],
  },
  {
    id: "developer",
    label: "Developer",
    name: "Rex",
    role: "software engineer",
    emoji: "🛠️",
    autonomy: "full",
    instructions:
      "Write and run code, scripts and small tools on the computer. Clone repositories into your workspace, test your changes, and tell me how to use what you built.",
    starters: [DAILY_CHECK_IN, WEEKLY_RETRO],
  },
];

/** The starters you picked from a template, or none for anything unknown. */
export function pickStarters(templateId: string | null, ids: string[]): StarterAutomation[] {
  const template = TEAMMATE_TEMPLATES.find((entry) => entry.id === templateId);
  return template?.starters.filter((starter) => ids.includes(starter.id)) ?? [];
}
