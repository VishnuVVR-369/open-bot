import type { ApprovalView } from "@open-bot/api";
import { CreditCard, FilePen, Mail, Plug, ShieldAlert, SquareTerminal } from "lucide-react-native";

/** The icon for what's being approved. */
export function ApprovalIcon({
  kind,
  size,
  color,
}: {
  kind: ApprovalView["kind"];
  size: number;
  color: string;
}) {
  const Icon =
    kind === "purchase"
      ? CreditCard
      : kind === "email"
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
