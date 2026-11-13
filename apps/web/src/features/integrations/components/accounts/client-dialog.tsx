"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
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
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import type { ProviderSetupView } from "@/lib/types";
import { CLIENT_GUIDES } from "../provider-guides";
import { useRefresh, CopyButton } from "./shared";

/** The OAuth client you made in a provider's console, which its integrations sign in through. */
export function ClientDialog({
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
              const saved = await attempt(
                api.accounts.saveClient({ provider: provider.id, clientId, clientSecret: secret }),
              );
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
