import { domainMatches } from "./vault";

/**
 * Job portals where a bot's browser must never submit an application. Applying stays yours: while you
 * have taken over a screen, the guard lets everything through.
 */
export const APPLY_GUARD_SITES: { domain: string; label: string }[] = [
  { domain: "linkedin.com", label: "LinkedIn" },
  { domain: "naukri.com", label: "Naukri" },
];

/**
 * What botd asks the browser to pause for a decision. Kept narrow so ordinary browsing never waits on the
 * guard; DevTools URL patterns are case-sensitive, so each spelling is listed.
 */
export const APPLY_GUARD_URL_PATTERNS = ["*apply*", "*Apply*", "*APPLY*"];

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The portal a request would submit an application to, or null. The portals' apply endpoints aren't
 * documented and change, so the rule is deliberately broad: on a guarded site, any request that changes
 * something and mentions "apply" in its address. Reading postings only needs GET requests.
 */
export function blockedApplication(
  url: string,
  method: string,
  extraDomains: string[] = [],
): { domain: string; label: string } | null {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/apply/i.test(parsed.pathname + parsed.search)) return null;
  const sites = [
    ...APPLY_GUARD_SITES,
    ...extraDomains.map((domain) => ({ domain, label: domain })),
  ];
  return sites.find((site) => domainMatches(parsed.hostname, site.domain)) ?? null;
}

/** What the bot is told when the guard stopped it, so it doesn't try again. */
export function applyBlockedMessage(labels: string[]): string {
  const where = [...new Set(labels)].join(" and ");
  return `open-bot blocked a job application from being submitted on ${where}. Teammates never apply to jobs: the user applies themselves. Don't try again; tell the user about the job instead.`;
}
