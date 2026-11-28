"use client";

import {
  cardBrand,
  cvcInput,
  expiryInput,
  groupCardNumber,
  rebaseVaultForm,
  VAULT_COPY,
  VAULT_NAME_MAX,
  vaultChange,
  vaultEditorTitle,
  vaultForm,
  vaultFormChanged,
  vaultFormProblem,
  vaultSaveLabel,
  vaultSavedTitle,
  vaultSecretInput,
  type VaultDraft,
  type VaultForm,
} from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useEffectEvent, useId, useState, useTransition, type ReactNode } from "react";
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
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import type { VaultItemView } from "@/lib/types";
import { cn } from "@/lib/utils";

type Kind = VaultItemView["kind"];

function Field({
  label,
  hint,
  children,
  htmlFor,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <span className="text-[12.5px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete = "off",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
        onClick={() => setShown((value) => !value)}
        aria-label={shown ? "Hide" : "Show"}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

/**
 * Add a login or card to the vault, or edit one when `item` is given. An edit sends only what you
 * changed (`vault.patch`), so a change made on the phone meanwhile stays, and what you haven't
 * touched follows the item while the dialog is open.
 */
export function VaultDialog({
  kind,
  item,
  trigger,
}: {
  kind: Kind;
  item?: VaultItemView;
  trigger: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VaultDraft>(() => {
    const start = vaultForm(item ?? null);
    return { start, form: start };
  });
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const editing = Boolean(item);
  const saved = editing ? VAULT_COPY.savedPlaceholder : undefined;
  const { start, form } = draft;
  const { name, domain, username, password, number, expiry, cvc, holder, zip } = form;
  const set = (patch: Partial<VaultForm>) =>
    setDraft((current) => ({ ...current, form: { ...current.form, ...patch } }));

  // Start from the item (or a blank one) each time the dialog opens. Secrets are never sent back.
  const reset = useEffectEvent(() => {
    const fresh = vaultForm(item ?? null);
    setDraft({ start: fresh, form: fresh });
  });
  useEffect(() => {
    if (open) reset();
  }, [open, item?.id]);
  // Changed elsewhere while it's open: what you haven't touched follows it.
  useEffect(() => {
    if (open && item) setDraft((current) => rebaseVaultForm(current, vaultForm(item)));
  }, [open, item]);

  const ready =
    vaultFormProblem(kind, form, editing) === null && (!editing || vaultFormChanged(start, form));

  function submit() {
    startTransition(async () => {
      const change = item ? vaultChange(kind, start, form) : null;
      if (item && !change) return setOpen(false);
      const result = await attempt(
        item
          ? api.vault.patch({ itemId: item.id, ...change })
          : api.vault.save({
              id: null,
              kind,
              name: name.trim(),
              domain,
              teammateIds: form.teammateIds,
              secret: vaultSecretInput(kind, form),
            }),
      );
      if (!result.ok) {
        toast.error("Couldn't save it", { description: result.error });
        return;
      }
      toast(vaultSavedTitle(kind, editing), { description: VAULT_COPY.savedToast });
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: orpc.vault.key() });
    });
  }

  const brand = number ? cardBrand(number) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="vault-dialog">
        <DialogHeader>
          <DialogTitle>{vaultEditorTitle(kind, item?.name ?? null)}</DialogTitle>
          <DialogDescription>
            {kind === "login" ? VAULT_COPY.loginDialog : VAULT_COPY.cardDialog}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !pending) submit();
          }}
        >
          <Field label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder={kind === "login" ? "GitHub" : "Personal Visa"}
              maxLength={VAULT_NAME_MAX}
            />
          </Field>
          {kind === "login" ? (
            <>
              <Field label="Site" htmlFor={`${id}-site`} hint={VAULT_COPY.siteHint}>
                <Input
                  id={`${id}-site`}
                  value={domain}
                  onChange={(event) => set({ domain: event.target.value })}
                  placeholder="github.com"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username or email" htmlFor={`${id}-username`}>
                  <Input
                    id={`${id}-username`}
                    value={username}
                    onChange={(event) => set({ username: event.target.value })}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Password" htmlFor={`${id}-password`}>
                  <SecretInput
                    id={`${id}-password`}
                    value={password}
                    onChange={(value) => set({ password: value })}
                    placeholder={saved}
                    autoComplete="new-password"
                  />
                </Field>
              </div>
            </>
          ) : (
            <>
              <Field label="Card number" htmlFor={`${id}-number`}>
                <div className="relative">
                  <Input
                    id={`${id}-number`}
                    value={number}
                    onChange={(event) => set({ number: groupCardNumber(event.target.value) })}
                    placeholder={editing ? item!.hint : "4242 4242 4242 4242"}
                    inputMode="numeric"
                    autoComplete="off"
                    className="pr-24 font-mono tabular-nums"
                  />
                  {brand && brand !== "Card" && (
                    <span className="absolute top-1/2 right-3 -translate-y-1/2 text-[12.5px] font-medium text-muted-foreground">
                      {brand}
                    </span>
                  )}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Expiry" htmlFor={`${id}-expiry`}>
                  <Input
                    id={`${id}-expiry`}
                    value={expiry}
                    onChange={(event) => set({ expiry: expiryInput(event.target.value) })}
                    placeholder={editing ? "Saved" : "MM/YY"}
                    inputMode="numeric"
                    autoComplete="off"
                    className="font-mono tabular-nums"
                  />
                </Field>
                <Field label="Security code" htmlFor={`${id}-cvc`}>
                  <SecretInput
                    id={`${id}-cvc`}
                    value={cvc}
                    onChange={(value) => set({ cvc: cvcInput(value) })}
                    placeholder={editing ? "Saved" : "123"}
                  />
                </Field>
                <Field label="ZIP code" htmlFor={`${id}-zip`} className="col-span-2 sm:col-span-1">
                  <Input
                    id={`${id}-zip`}
                    value={zip}
                    onChange={(event) => set({ zip: event.target.value })}
                    placeholder={editing ? "Saved" : "Optional"}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <Field label="Name on the card" htmlFor={`${id}-holder`}>
                <Input
                  id={`${id}-holder`}
                  value={holder}
                  onChange={(event) => set({ holder: event.target.value })}
                  placeholder={saved}
                  autoComplete="off"
                />
              </Field>
            </>
          )}
          <div className="rounded-xl border bg-subtle/60 p-3.5">
            <AccessPicker
              value={form.teammateIds}
              onChange={(teammateIds) => set({ teammateIds })}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending} data-testid="vault-save">
              {pending && <Loader2 className="animate-spin" />}
              {vaultSaveLabel(kind, editing)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
