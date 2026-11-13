"use client";

import {
  authProvider,
  defaultCapabilities,
  integration,
  integrationsOf,
  type AccountCapability,
  type AccountConnectionKind,
} from "@open-bot/domain";
import { Loader2 } from "lucide-react";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { AccessPicker } from "@/components/access-picker";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AccountsSetupView, ConnectionView } from "@/lib/types";
import { providerSetup, signIn } from "./shared";
import { ClientDialog } from "./client-dialog";
import { CapabilityPicker } from "./capability-picker";

/** Connect an integration: what teammates may do, who may, and then sign in. */
export function ConnectDialog({
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
                  teammateIds: access,
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
