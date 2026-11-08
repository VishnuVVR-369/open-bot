import type { AccountProvider } from "@open-bot/domain";
import type { ReactNode } from "react";

/**
 * How to make the OAuth client a provider needs from you, for providers whose client you paste in
 * (`client: "owner"` in shared's AUTH_PROVIDERS). The dialog around it is the same for all.
 */
export interface ClientGuide {
  title: string;
  description: ReactNode;
  /** The steps, with the redirect URI to register shown where it goes. */
  steps: (redirectUri: ReactNode) => ReactNode;
  clientIdPlaceholder: string;
  secretPlaceholder: string;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="font-medium underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

export const CLIENT_GUIDES: Partial<Record<AccountProvider, ClientGuide>> = {
  google: {
    title: "Set up Google",
    description: (
      <>
        Gmail and Calendar sign in through an OAuth client in your own Google Cloud project, so your
        mail never passes through anyone else&apos;s app. It takes about five minutes, once.
      </>
    ),
    steps: (redirectUri) => (
      <>
        <li>
          In the{" "}
          <Link href="https://console.cloud.google.com/projectcreate">Google Cloud console</Link>,
          create a project, then enable the{" "}
          <Link href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">
            Gmail API
          </Link>{" "}
          and the{" "}
          <Link href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">
            Google Calendar API
          </Link>
          .
        </li>
        <li>
          Under{" "}
          <Link href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Link>,
          set the audience to External and publish the app (In production). Google will call it
          unverified; that&apos;s expected for an app only you use, and it keeps your sign-in from
          expiring after 7 days.
        </li>
        <li>
          Under Clients, create a client of type Web application, with this authorized redirect URI:
          {redirectUri}
        </li>
        <li>Paste the client&apos;s ID and secret here.</li>
      </>
    ),
    clientIdPlaceholder: "1234-abc.apps.googleusercontent.com",
    secretPlaceholder: "GOCSPX-…",
  },
};
