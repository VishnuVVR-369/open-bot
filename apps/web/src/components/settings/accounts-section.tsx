"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ACCOUNT_CONNECTION_KINDS,
  authProvider,
  capabilityLabel,
  capabilityOption,
  defaultCapabilities,
  integration,
  integrationSettings,
  integrationsOf,
  type AccountCapability,
  type AccountConnectionKind,
  type IntegrationIcon,
} from "@open-bot/shared";
import {
  CalendarDays,
  Copy,
  ExternalLink,
  Loader2,
  Mail,
  NotebookText,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { AccessPicker } from "@/components/access-picker";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  deleteConnection,
  saveAccountConnection,
  saveOAuthClient,
  setConnectionEnabled,
  startAccountConnect,
} from "@/lib/actions";
import { queryKeys, useAccountsSetup, useAppState } from "@/lib/client/queries";
import type {
  AccountsSetupView,
  ConnectionTestView,
  ConnectionView,
  ProviderSetupView,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { TestResult } from "./connection-test-result";
import { CLIENT_GUIDES } from "./provider-guides";

const ICONS: Record<IntegrationIcon, typeof Mail> = {
  mail: Mail,
  calendar: CalendarDays,
  notebook: NotebookText,
};

function iconFor(kind: AccountConnectionKind) {
  return ICONS[integration(kind).icon];
}

/** The provider an integration signs in through, as setup describes it. */
function providerSetup(setup: AccountsSetupView, kind: AccountConnectionKind): ProviderSetupView {
  const id = integration(kind).provider;
  return setup.providers.find((entry) => entry.id === id)!;
}

/** What a connection lets teammates do, in a few words. */
function canSummary(kind: AccountConnectionKind, capabilities: AccountCapability[]): string {
  return capabilities
    .map((capability) => capabilityOption(kind, capability)?.short)
    .filter(Boolean)
    .join(", ");
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.connections });
}

/** Go to the provider's sign-in page. */
async function signIn(input: {
  kind: AccountConnectionKind;
  capabilities: AccountCapability[];
  botIds: string[] | null;
  accountId: string | null;
}): Promise<boolean> {
  const started = await startAccountConnect(input);
  if (!started.ok) {
    toast.error("Couldn't start connecting", { description: started.error });
    return false;
  }
  window.location.assign(started.data.url);
  return true;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            toast("Copied");
          }}
        >
          <Copy />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The OAuth client you made in a provider's console, which its integrations sign in through. */
function ClientDialog({
  provider,
  trigger,
  onSaved,
}: {
  provider: ProviderSetupView;
  trigger: ReactNode;
  onSaved?: () => void;
}) {
  const id = useId();
  const guide = CLIENT_GUIDES[provider.id];
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, startTransition] = useTransition();
  const refresh = useRefresh();

  useEffect(() => {
    if (!open) return;
    setClientId("");
    setSecret("");
  }, [open]);

  const ready = clientId.trim() && secret.trim();
  const redirect = (
    <span className="mt-1.5 flex min-w-0 items-center gap-1 rounded-lg border bg-subtle/60 py-1 pr-1 pl-2.5">
      <code
        className="min-w-0 flex-1 truncate font-mono text-[12px]"
        data-testid="oauth-redirect-uri"
      >
        {provider.redirectUri}
      </code>
      <CopyButton text={provider.redirectUri} label="Copy the redirect URI" />
    </span>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="oauth-client-dialog"
        data-provider={provider.id}
        onOpenAutoFocus={(event) => {
          // Not the copy button: its tooltip would open, and take the first Escape.
          event.preventDefault();
          document.getElementById(`${id}-client`)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{guide?.title ?? `Set up ${provider.label}`}</DialogTitle>
          <DialogDescription>
            {guide?.description ??
              `${provider.label} signs in through an OAuth client you make in its developer console.`}
          </DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2.5 pl-5 text-[13.5px] leading-relaxed marker:text-muted-foreground">
          {guide ? (
            guide.steps(redirect)
          ) : (
            <>
              <li>
                Create an OAuth client, with this redirect URI:
                {redirect}
              </li>
              <li>Paste the client&apos;s ID and secret here.</li>
            </>
          )}
        </ol>
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || pending) return;
            startTransition(async () => {
              const saved = await saveOAuthClient({
                provider: provider.id,
                clientId,
                clientSecret: secret,
              });
              if (!saved.ok) {
                toast.error("Couldn't save it", { description: saved.error });
                return;
              }
              setOpen(false);
              await refresh();
              onSaved?.();
            });
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-client`}>Client ID</Label>
            <Input
              id={`${id}-client`}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder={
                provider.hint ? `Saved: ${provider.hint}` : (guide?.clientIdPlaceholder ?? "")
              }
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono text-[13px]"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-secret`}>Client secret</Label>
            <Input
              id={`${id}-secret`}
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={guide?.secretPlaceholder ?? ""}
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono text-[13px]"
            />
            <span className="text-[12.5px] text-muted-foreground">Stored encrypted.</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending} data-testid="oauth-client-save">
              {pending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The switches for what teammates may do with an account. */
function CapabilityPicker({
  kind,
  value,
  onChange,
}: {
  kind: AccountConnectionKind;
  value: AccountCapability[];
  onChange: (value: AccountCapability[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3" role="group" aria-label="What teammates can do">
      {integration(kind).capabilities.map((option) => (
        <label
          key={option.capability}
          className={cn(
            "flex items-center justify-between gap-4",
            option.required ? "cursor-default" : "cursor-pointer",
          )}
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] font-medium">{option.label}</span>
            <span className="text-[12.5px] text-muted-foreground">{option.description}</span>
          </span>
          <Switch
            checked={option.required || value.includes(option.capability)}
            disabled={option.required}
            aria-label={option.label}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, option.capability]
                  : value.filter((entry) => entry !== option.capability),
              )
            }
          />
        </label>
      ))}
    </div>
  );
}

/** Connect an integration: what teammates may do, who may, and then sign in. */
function ConnectDialog({
  kind,
  setup,
  connections,
  trigger,
  open: controlled,
  onOpenChange,
}: {
  kind: AccountConnectionKind;
  setup: AccountsSetupView;
  connections: ConnectionView[];
  /** Opens it; or pass open and onOpenChange to open it from elsewhere, like a menu. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const definition = integration(kind);
  const provider = providerSetup(setup, kind);
  const accountLabel = authProvider(provider.id).accountLabel;
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [capabilities, setCapabilities] = useState<AccountCapability[]>(defaultCapabilities(kind));
  const [access, setAccess] = useState<string[] | null>(null);
  const [account, setAccount] = useState<string>("new");
  const [pending, startTransition] = useTransition();

  // Accounts you signed in to for another of the provider's integrations, which this one can use
  // too (a Google account used for Calendar can serve Gmail).
  const usable = setup.accounts.filter(
    (entry) =>
      entry.provider === provider.id &&
      entry.status === "connected" &&
      !connections.some(
        (connection) => connection.kind === kind && connection.account?.id === entry.id,
      ),
  );
  useEffect(() => {
    if (!open) return;
    setCapabilities(defaultCapabilities(kind));
    setAccess(null);
    setAccount(usable[0]?.id ?? "new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const needsClient = !provider.configured;
  const ready = !needsClient && (access === null || access.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg" data-testid="account-connect-dialog">
        <DialogHeader>
          <DialogTitle>Connect {definition.label}</DialogTitle>
          <DialogDescription>{definition.description}</DialogDescription>
        </DialogHeader>
        {needsClient ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border bg-subtle/60 px-3.5 py-3">
            <p className="text-[13.5px]">
              {integrationsOf(provider.id)
                .map((entry) => entry.label)
                .join(" and ")}{" "}
              sign in through your own {provider.label} OAuth client. Set it up first.
            </p>
            <ClientDialog
              provider={provider}
              trigger={
                <Button size="sm" variant="outline">
                  Set up {provider.label}
                </Button>
              }
            />
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ready || pending) return;
              startTransition(async () => {
                await signIn({
                  kind,
                  capabilities,
                  botIds: access,
                  accountId: account !== "new" ? account : null,
                });
              });
            }}
          >
            {usable.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label>{accountLabel[0]!.toUpperCase() + accountLabel.slice(1)}</Label>
                <RadioGroup value={account} onValueChange={setAccount} className="gap-2.5">
                  {usable.map((entry) => (
                    <label
                      key={entry.id}
                      className="flex cursor-pointer items-center gap-2.5 text-[14px]"
                    >
                      <RadioGroupItem value={entry.id} />
                      {entry.display}
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
                    <RadioGroupItem value="new" />
                    Another {accountLabel}
                  </label>
                </RadioGroup>
              </div>
            )}
            <div className="rounded-xl border bg-subtle/60 p-3.5">
              <CapabilityPicker kind={kind} value={capabilities} onChange={setCapabilities} />
            </div>
            <div className="rounded-xl border bg-subtle/60 p-3.5">
              <AccessPicker value={access} onChange={setAccess} />
            </div>
            {definition.connectNote && (
              <p className="rounded-xl border bg-subtle/60 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground">
                {definition.connectNote}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!ready || pending} data-testid="account-continue">
                {pending && <Loader2 className="animate-spin" />}
                Continue to {provider.label}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Change what an account connection allows, who uses it, and when it asks you. */
function EditDialog({
  connection,
  kind,
}: {
  connection: ConnectionView;
  kind: AccountConnectionKind;
}) {
  const id = useId();
  const provider = authProvider(integration(kind).provider);
  const fields = integrationSettings(kind);
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<AccountCapability[]>(connection.capabilities);
  const [access, setAccess] = useState<string[] | null>(connection.botIds);
  const [ask, setAsk] = useState(connection.askBeforeActing);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [pending, startTransition] = useTransition();
  const refresh = useRefresh();

  useEffect(() => {
    if (!open) return;
    setCapabilities(connection.capabilities);
    setAccess(connection.botIds);
    setAsk(connection.askBeforeActing);
    setSettings(typedSettings(connection));
    setConsent(false);
  }, [open, connection]);

  const ready = access === null || access.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${connection.label}`}>
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="account-edit-dialog">
        <DialogHeader>
          <DialogTitle>{connection.label}</DialogTitle>
          <DialogDescription>
            Signed in as {connection.account?.display}. Changing what it allows or who uses it
            cancels anything still waiting for your approval on it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || pending) return;
            startTransition(async () => {
              if (consent) {
                await signIn({
                  kind,
                  capabilities,
                  botIds: access,
                  accountId: connection.account?.id ?? null,
                });
                return;
              }
              // Only what you changed: a value read back as its link can lose what it was called.
              const before = typedSettings(connection);
              const changed = Object.fromEntries(
                Object.entries(settings).filter(([key, value]) => value !== before[key]),
              );
              const saved = await saveAccountConnection({
                id: connection.id,
                capabilities,
                botIds: access,
                askBeforeActing: ask,
                ...(Object.keys(changed).length > 0 ? { settings: changed } : {}),
              });
              if (!saved.ok) {
                toast.error("Couldn't save it", { description: saved.error });
                return;
              }
              if (saved.data.needsConsent) {
                setConsent(true);
                return;
              }
              setOpen(false);
              await refresh();
            });
          }}
        >
          <div className="rounded-xl border bg-subtle/60 p-3.5">
            <CapabilityPicker
              kind={kind}
              value={capabilities}
              onChange={(value) => {
                setCapabilities(value);
                setConsent(false);
              }}
            />
          </div>
          <div className="rounded-xl border bg-subtle/60 p-3.5">
            <AccessPicker value={access} onChange={setAccess} />
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border bg-subtle/60 p-3.5">
            <span className="flex flex-col gap-0.5">
              <span className="text-[14px] font-medium">Always ask before acting for me</span>
              <span className="text-[12.5px] text-muted-foreground">
                Sending, inviting and anything others see asks you first. Off lets teammates that
                work fully on their own skip asking, unless they just read something from outside.
              </span>
            </span>
            <Switch
              checked={ask}
              onCheckedChange={setAsk}
              aria-label="Always ask before acting for me"
            />
          </label>
          {fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-2">
              <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
              <Input
                id={`${id}-${field.key}`}
                value={settings[field.key] ?? ""}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, [field.key]: event.target.value }))
                }
                placeholder={field.placeholder}
                spellCheck={false}
                autoCapitalize="off"
              />
              <span className="text-[12.5px] text-muted-foreground">{field.help}</span>
            </div>
          ))}
          {consent && (
            <p className="flex items-start gap-2 rounded-lg bg-manual/12 px-3 py-2 text-[13px]">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {provider.label} hasn&apos;t granted this yet. Continue to sign in again and allow it.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending} data-testid="account-save">
              {pending && <Loader2 className="animate-spin" />}
              {consent ? `Continue to ${provider.label}` : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A connection's settings as the edit dialog's fields show them: their links. */
function typedSettings(connection: ConnectionView): Record<string, string> {
  return Object.fromEntries(connection.settings.map((value) => [value.key, value.url ?? value.id]));
}

function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** One connected account, like the MCP rows: Test, edit, remove, on or off. */
function AccountRow({
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
        botIds: connection.botIds,
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
                  const removed = await deleteConnection(connection.id);
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
          const changed = await setConnectionEnabled(connection.id, checked);
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-manual/12 px-3 py-2 text-[13px]">
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-manual-ink" />
              Needs reconnecting{account?.lastError ? `: ${account.lastError}` : "."}
            </span>
            <Button size="sm" variant="outline" onClick={reconnect} disabled={reconnecting}>
              {reconnecting && <Loader2 className="animate-spin" />}
              Reconnect
            </Button>
          </div>
        ) : connection.missingCapabilities.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-manual/12 px-3 py-2 text-[13px]">
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-manual-ink" />
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
            <span className="flex items-center gap-1.5 text-[12.5px] text-manual-ink">
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

/** A kind of account that isn't connected yet. */
function ConnectRow({
  kind,
  setup,
  connections,
}: {
  kind: AccountConnectionKind;
  setup: AccountsSetupView;
  connections: ConnectionView[];
}) {
  const Icon = iconFor(kind);
  const definition = integration(kind);
  return (
    <li
      className="flex items-center gap-3 px-4 py-3"
      data-testid="account-connect"
      data-kind={kind}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium">{definition.label}</span>
        <span className="text-[12.5px] text-muted-foreground">{definition.description}</span>
      </div>
      <ConnectDialog
        kind={kind}
        setup={setup}
        connections={connections}
        trigger={
          <Button variant="outline" size="sm" data-testid={`connect-${kind}`}>
            Connect
          </Button>
        }
      />
    </li>
  );
}

/**
 * Your own accounts' services (Gmail, Calendar, Notion, …), as shared's integration registry lists
 * them. Teammates use them through the worker, which keeps the tokens; they act as you, so
 * anything others see asks you first.
 */
export function AccountsSection({
  connections,
  results,
  testing,
  onTest,
}: {
  connections: ConnectionView[];
  results: Record<string, ConnectionTestView>;
  testing: string | null;
  onTest: (id: string) => void;
}) {
  const { data: setup } = useAccountsSetup();
  // Stays mounted after closing, so the dialog animates out.
  const [another, setAnother] = useState<{ kind: AccountConnectionKind; open: boolean } | null>(
    null,
  );
  if (!setup) return null;
  const connected = connections.filter((connection) => connection.kind !== "mcp");
  const missing = ACCOUNT_CONNECTION_KINDS.filter(
    (kind) => !connected.some((connection) => connection.kind === kind),
  );
  // Providers whose client you pasted in, to change it later.
  const owned = setup.providers.filter((entry) => entry.client === "owner" && entry.configured);

  return (
    <div className="flex flex-col gap-2.5" data-testid="accounts">
      <ul className="flex flex-col divide-y rounded-xl border bg-card">
        {connected.map((connection) => (
          <AccountRow
            key={connection.id}
            connection={connection}
            kind={connection.kind as AccountConnectionKind}
            result={results[connection.id]}
            testing={testing === connection.id}
            onTest={() => onTest(connection.id)}
          />
        ))}
        {missing.map((kind) => (
          <ConnectRow key={kind} kind={kind} setup={setup} connections={connected} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {missing.length < ACCOUNT_CONNECTION_KINDS.length && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Plus />
                Connect another account
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {ACCOUNT_CONNECTION_KINDS.filter((kind) => !missing.includes(kind)).map((kind) => {
                const Icon = iconFor(kind);
                return (
                  <DropdownMenuItem key={kind} onSelect={() => setAnother({ kind, open: true })}>
                    <Icon />
                    {integration(kind).label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {another && (
          <ConnectDialog
            kind={another.kind}
            setup={setup}
            connections={connected}
            open={another.open}
            onOpenChange={(open) => setAnother({ kind: another.kind, open })}
          />
        )}
        {owned.map((provider) => (
          <ClientDialog
            key={provider.id}
            provider={provider}
            trigger={
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                {provider.label} client
              </Button>
            }
          />
        ))}
      </div>
    </div>
  );
}
