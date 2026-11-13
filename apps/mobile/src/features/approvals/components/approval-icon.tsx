import type { ApprovalView } from "@open-bot/api";
import { CreditCard, FilePen, Mail, Plug, ShieldAlert, SquareTerminal } from "lucide-react-native";
import { sendsEmail } from "@/features/approvals/approval-text";

/** The icon for what's being approved. Mail through a connected account is still mail. */
export function ApprovalIcon({
  kind,
  title = "",
  preview,
  size,
  color,
}: {
  kind: ApprovalView["kind"];
  title?: string;
  preview?: { type: string } | null;
  size: number;
  color: string;
}) {
  const Icon =
    kind === "purchase"
      ? CreditCard
      : sendsEmail({ kind, title, preview })
        ? Mail
        : kind === "command"
          ? SquareTerminal
          : kind === "file_change"
            ? FilePen
            : kind === "account_write" || kind === "account_outward"
              ? Plug
              : ShieldAlert;
  return <Icon size={size} color={color} />;
}
