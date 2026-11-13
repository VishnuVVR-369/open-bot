"use client";

import {
  authProvider,
  capabilityLabel,
  integration,
  integrationSettings,
  integrationsOf,
  type AccountConnectionKind,
} from "@open-bot/domain";
import { ExternalLink, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { attempt } from "@/lib/client/mutate";
import { useAppState } from "@/features/app-shell";
import { api } from "@/lib/client/rpc";
import type { ConnectionTestView, ConnectionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TestResult } from "../connection-test-result";
import { iconFor, canSummary, useRefresh, signIn } from "./shared";
import { EditDialog } from "./edit-dialog";

function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** One connected account, like the MCP rows: Test, edit, remove, on or off. */
export function AccountRow({
  connection,
  kind,
  result,
  testing,
  onTest,
}: {
  connection: ConnectionView;
  kind: AccountConnectionKind;
  result: ConnectionTestView | undefined;
  testing: boolean;
  onTest: () => void;
}) {
  const { data: state } = useAppState();
  const refresh = useRefresh();
  const [reconnecting, startReconnect] = useTransition();
  const Icon = iconFor(kind);
  const provider = authProvider(integration(kind).provider);
  const fields = integrationSettings(kind);
  const account = connection.account;
  const people =
    connection.botIds === null
      ? "Every teammate"
      : connection.botIds.length === 1
        ? `Only ${state?.bots.find((bot) => bot.id === connection.botIds![0])?.name ?? "one teammate"}`
        : `${connection.botIds.length} teammates`;
  const broken = account?.status !== "connected";
  const endsSoon =
    account?.expiresAt && new Date(account.expiresAt).getTime() - Date.now() < 14 * 86_400_000;
  const reconnect = () =>
    startReconnect(async () => {
      await signIn({
        kind,
        capabilities: connection.capabilities,
        teammateIds: connection.botIds,
        accountId: account?.id ?? null,
      });
    });
  // One sign-in serves several integrations (Google's Gmail and Calendar).
  const shared = integrationsOf(provider.id).length > 1;

  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
      data-testid="account-connection"
      data-kind={kind}
    >
      <span
        className={cn(
          "col-start-1 row-start-1 flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-foreground/75",
          !connection.enabled && "opacity-50",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div
        className={cn(
          "col-start-2 row-start-1 flex min-w-0 flex-col",
          !connection.enabled && "opacity-60",
        )}
      >
        <span className="truncate text-[14px] font-medium">{connection.label}</span>
        <span className="flex min-w-0 gap-1 text-[12.5px] text-muted-foreground">
          <span className="truncate">{account?.display}</span>
          <span className="hidden shrink-0 sm:inline">· {people}</span>
          {!connection.enabled && <span className="shrink-0">· Off</span>}
        </span>
      </div>
      <div className="col-[2/-1] row-start-3 flex items-center gap-1 sm:col-[3/4] sm:row-start-1">
        <Button
          variant="outline"
          size="sm"
          className="mr-1"
          onClick={onTest}
          disabled={testing || broken}
        >
          {testing && <Loader2 className="animate-spin" />}
          Test
        </Button>
        <EditDialog connection={connection} kind={kind} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${connection.label}`}>
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {connection.label}?</AlertDialogTitle>
              <AlertDialogDescription>
                Teammates lose it from their next message, and anything waiting for your approval on
                it is cancelled.{" "}
                {shared
                  ? `If nothing else uses ${account?.display ?? "the account"}, open-bot's access to it is revoked at ${provider.label}.`
                  : `open-bot's access to ${account?.display ?? "it"} is revoked at ${provider.label}.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={async () => {
                  const removed = await attempt(
                    api.connections.remove({ connectionId: connection.id }),
                  );
                  if (!removed.ok) toast.error(removed.error);
                  else if (removed.data.warning) toast.warning(removed.data.warning);
                  await refresh();
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <Switch
        className="col-start-3 row-start-1 sm:col-start-4"
        checked={connection.enabled}
        aria-label={`Use ${connection.label}`}
        onCheckedChange={async (checked) => {
          const changed = await attempt(
            api.connections.setEnabled({ connectionId: connection.id, enabled: checked }),
          );
          if (!changed.ok) toast.error(changed.error);
          await refresh();
        }}
      />
      <div className="col-[2/-1] row-start-2 flex min-w-0 flex-col gap-2">
        <span className="text-[12.5px] text-muted-foreground">
          {canSummary(kind, connection.capabilities)}
          {connection.settings.map((value) => (
            <span key={value.key}>
              {` · ${fields.find((field) => field.key === value.key)?.noun ?? value.key} `}
              {value.url ? (
                <a
                  className="inline-flex items-center gap-0.5 underline underline-offset-2"
                  href={value.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {value.title}
                  <ExternalLink className="size-3" />
                </a>
              ) : (
                value.title
              )}
            </span>
          ))}
          {!connection.askBeforeActing && " · doesn't always ask"}
        </span>
        {broken ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-attention/12 px-3 py-2 text-[13px]">
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-attention-ink" />
              Needs reconnecting{account?.lastError ? `: ${account.lastError}` : "."}
            </span>
            <Button size="sm" variant="outline" onClick={reconnect} disabled={reconnecting}>
              {reconnecting && <Loader2 className="animate-spin" />}
              Reconnect
            </Button>
          </div>
        ) : connection.missingCapabilities.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-attention/12 px-3 py-2 text-[13px]">
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-attention-ink" />
              {provider.label} didn&apos;t grant{" "}
              {connection.missingCapabilities
                .map((capability) => `“${capabilityLabel(kind, capability)}”`)
                .join(" or ")}
              , so teammates can&apos;t do that yet.
            </span>
            <Button size="sm" variant="outline" onClick={reconnect} disabled={reconnecting}>
              {reconnecting && <Loader2 className="animate-spin" />}
              Allow it
            </Button>
          </div>
        ) : (
          endsSoon && (
            <span className="flex items-center gap-1.5 text-[12.5px] text-attention-ink">
              {provider.label} asks you to sign in again by {dateText(account!.expiresAt!)}.
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={reconnect}
              >
                Reconnect now
              </button>
            </span>
          )
        )}
        {testing ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking with {provider.label}…
          </p>
        ) : (
          result && <TestResult result={result} summary={result.status ?? "Connected"} />
        )}
      </div>
    </li>
  );
}
