"use client";

import { Bell, Brain, Plug, ShieldCheck, SunMoon, UserRound } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { ConnectionsSection } from "@/components/settings/connections-section";
import { EmailSection } from "@/components/settings/email-section";
import { PushSection } from "./push-section";
import { ProfileEditor } from "./profile-editor";
import { PasswordSection } from "./password-section";
import { TelegramSection } from "./telegram-section";
import { Section } from "./section";
import { ChatgptSection } from "./chatgpt-section";
import { BrowsingSection } from "./browsing-section";
import { TimezoneSection } from "./timezone-section";
import { NotificationsSection } from "./notifications-section";
import { PasskeySection } from "./passkey-section";
import { FallbackSection } from "./fallback-section";
import { UsageSection } from "./usage-section";
import { ProfileBlock } from "./profile-block";
import { AppearanceSection } from "./appearance-section";

type GroupId = "account" | "memory" | "appearance" | "notifications" | "connections" | "security";

/** Settings in groups, one group at a time. Old links to a section (#email) open its group. */
const GROUPS: { id: GroupId; label: string; icon: typeof UserRound; sections: string[] }[] = [
  {
    id: "account",
    label: "Account",
    icon: UserRound,
    sections: ["chatgpt", "plan", "usage", "timezone"],
  },
  { id: "memory", label: "Memory", icon: Brain, sections: ["about"] },
  { id: "appearance", label: "Appearance", icon: SunMoon, sections: [] },
  { id: "notifications", label: "Notifications", icon: Bell, sections: ["telegram"] },
  { id: "connections", label: "Connections", icon: Plug, sections: ["email", "browsing"] },
  {
    id: "security",
    label: "Security",
    icon: ShieldCheck,
    sections: ["password", "set-password", "passkeys"],
  },
];

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function useHash() {
  return useSyncExternalStore(
    subscribeHash,
    () => decodeURIComponent(window.location.hash.slice(1)),
    () => "",
  );
}

function groupFor(hash: string): GroupId {
  return (
    GROUPS.find((group) => group.id === hash || group.sections.includes(hash))?.id ?? "account"
  );
}

function SettingsNav({ current }: { current: GroupId }) {
  return (
    <nav aria-label="Settings" className="md:sticky md:top-0 md:self-start">
      <ul className="-mx-5 flex gap-1 overflow-x-auto px-5 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-0.5 md:px-0">
        {GROUPS.map((group) => {
          const Icon = group.icon;
          const active = group.id === current;
          return (
            <li key={group.id} className="shrink-0">
              <a
                href={`#${group.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-lg px-3 text-[14px] whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12",
                  // A quiet gray fill marks where you are; on the white page a raised white
                  // surface didn't show.
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-subtle hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {group.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function GroupContent({ group, hash }: { group: GroupId; hash: string }) {
  switch (group) {
    case "account":
      return (
        <>
          <ProfileBlock />
          <Section
            id="chatgpt"
            title="ChatGPT"
            description="Your teammates run on your ChatGPT plan through Codex on the computer."
          >
            <ChatgptSection />
          </Section>
          <Section
            id="plan"
            title="When your plan runs out"
            description="Teammates use your ChatGPT plan first. If its limit is reached, they can continue on an OpenAI API key, up to a monthly cap."
          >
            <FallbackSection />
          </Section>
          <Section id="usage" title="Usage" description="Tokens your teammates used this month.">
            <UsageSection />
          </Section>
          <Section
            id="timezone"
            title="Timezone"
            description="Used for schedules, and so your teammates know what time it is for you."
          >
            <TimezoneSection />
          </Section>
        </>
      );
    case "memory":
      return (
        <Section
          id="about"
          title="About you"
          description="Facts and preferences every teammate can use, with where each came from. Suggestions become memory when you confirm them."
        >
          <ProfileEditor />
        </Section>
      );
    case "appearance":
      return (
        <Section
          id="appearance"
          title="Appearance"
          description="How open-bot looks on this device."
        >
          <AppearanceSection />
        </Section>
      );
    case "notifications":
      return (
        <>
          <Section
            id="notifications"
            title="Notifications"
            description="Know when a teammate finishes or needs you, on this computer and your phone."
          >
            <PushSection fallback={<NotificationsSection />} />
          </Section>
          <Section
            id="telegram"
            title="Telegram"
            description="Approve, take over and talk to your teammates from your phone."
          >
            <TelegramSection />
          </Section>
        </>
      );
    case "connections":
      return (
        <>
          <Section
            id="connections"
            title="Connections"
            description="Your Gmail, Calendar and Notion, and other services your teammates use through MCP, like GitHub or your own API."
          >
            <ConnectionsSection />
          </Section>
          <Section
            id="email"
            title="Email"
            description="An address for every teammate. Forward them receipts, threads and requests; they answer from their own address."
          >
            <EmailSection />
          </Section>
          <Section
            id="browsing"
            title="Browsing"
            description="Websites often block cloud IPs. The desktop app can route the computer's browser through your home connection."
          >
            <BrowsingSection />
          </Section>
        </>
      );
    case "security":
      return (
        <>
          <Section id="password" title="Password" description="The password you sign in with.">
            <PasswordSection startWithReset={hash === "set-password"} />
          </Section>
          <Section
            id="passkeys"
            title="Passkeys"
            description="Sign in with Touch ID or your phone instead of a password. A passkey also gets you in if you forget your password."
          >
            <PasskeySection />
          </Section>
        </>
      );
  }
}

export function SettingsView() {
  const hash = useHash();
  const group = groupFor(hash);
  // A link to one section (#email) opens its group, then shows that section.
  useEffect(() => {
    if (!hash || hash === group) return;
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [hash, group]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[176px_minmax(0,1fr)] md:gap-12">
      <SettingsNav current={group} />
      <div
        key={group}
        className={cn("flex min-w-0 flex-col gap-10", group === "security" && "max-w-[600px]")}
        data-testid={`settings-${group}`}
      >
        <GroupContent group={group} hash={hash} />
      </div>
    </div>
  );
}
