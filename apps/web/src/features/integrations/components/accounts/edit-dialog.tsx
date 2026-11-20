"use client";

import {
  authProvider,
  integration,
  integrationSettings,
  type AccountCapability,
  type AccountConnectionKind,
} from "@open-bot/domain";
import { Loader2, Pencil, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import type { ConnectionView } from "@/lib/types";
import { useRefresh, signIn } from "./shared";
import { CapabilityPicker } from "./capability-picker";

/** Change what an account connection allows, who uses it, and when it asks you. */
export function EditDialog({
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
  const [access, setAccess] = useState<string[] | null>(connection.teammateIds);
  const [ask, setAsk] = useState(connection.askBeforeActing);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [pending, startTransition] = useTransition();
  const refresh = useRefresh();

  useEffect(() => {
    if (!open) return;
    setCapabilities(connection.capabilities);
    setAccess(connection.teammateIds);
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
                  teammateIds: access,
                  accountId: connection.account?.id ?? null,
                });
                return;
              }
              // Only what you changed: a value read back as its link can lose what it was called.
              const before = typedSettings(connection);
              const changed = Object.fromEntries(
                Object.entries(settings).filter(([key, value]) => value !== before[key]),
              );
              const saved = await attempt(
                api.accounts.update({
                  connectionId: connection.id,
                  capabilities,
                  teammateIds: access,
                  askBeforeActing: ask,
                  ...(Object.keys(changed).length > 0 ? { settings: changed } : {}),
                }),
              );
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
            <p className="flex items-start gap-2 rounded-lg bg-attention/12 px-3 py-2 text-[13px]">
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
