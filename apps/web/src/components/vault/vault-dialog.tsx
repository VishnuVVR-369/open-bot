"use client";

import { cardBrand, cardDigits } from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
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
import { saveVaultItem } from "@/lib/actions";
import { queryKeys } from "@/lib/client/queries";
import type { VaultItemView } from "@/lib/types";
import { cn } from "@/lib/utils";

type Kind = VaultItemView["kind"];

/** "4242 4242 4242 4242", grouped as the card prints it, while you type. */
function groupCardNumber(value: string): string {
  const digits = cardDigits(value).replace(/\D/g, "").slice(0, 19);
  const groups = /^3[47]/.test(digits) ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let offset = 0;
  for (const size of groups) {
    if (offset >= digits.length) break;
    parts.push(digits.slice(offset, offset + size));
    offset += size;
  }
  return parts.join(" ");
}

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

/** Add a login or card to the vault, or edit one when `item` is given. */
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
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [zip, setZip] = useState("");
  const [access, setAccess] = useState<string[] | null>(null);
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const editing = Boolean(item);
  const saved = editing ? "Saved. Type to replace it." : undefined;

  // Start from the item (or a blank one) each time the dialog opens. Secrets are never sent back.
  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? "");
    setDomain(item?.domain ?? "");
    setUsername(item?.kind === "login" ? item.hint : "");
    setPassword("");
    setNumber("");
    setExpiry("");
    setCvc("");
    setHolder("");
    setZip("");
    setAccess(item ? item.botIds : null);
  }, [open, item]);

  const ready =
    name.trim() &&
    (access === null || access.length > 0) &&
    (kind === "login"
      ? domain.trim() && username.trim() && (editing || password)
      : editing || (number && expiry && cvc && holder.trim()));

  function submit() {
    startTransition(async () => {
      const result = await saveVaultItem({
        id: item?.id ?? null,
        kind,
        name: name.trim(),
        domain,
        botIds: access,
        secret:
          kind === "login" ? { username, password } : { number, expiry, cvc, name: holder, zip },
      });
      if (!result.ok) {
        toast.error("Couldn't save it", { description: result.error });
        return;
      }
      toast(editing ? "Saved" : kind === "login" ? "Login saved" : "Card saved", {
        description: "Teammates fill it in on the computer without seeing it.",
      });
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.vault });
    });
  }

  const brand = number ? cardBrand(number) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="vault-dialog">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${item!.name}` : kind === "login" ? "Add a login" : "Add a card"}
          </DialogTitle>
          <DialogDescription>
            {kind === "login"
              ? "Teammates type it in for you on this site, and only on this site. They never see the password."
              : "Teammates fill it in at checkout, only for purchases within their budget. They never see the number."}
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
              onChange={(event) => setName(event.target.value)}
              placeholder={kind === "login" ? "GitHub" : "Personal Visa"}
              maxLength={80}
            />
          </Field>
          {kind === "login" ? (
            <>
              <Field label="Site" htmlFor={`${id}-site`} hint="It also works on its subdomains.">
                <Input
                  id={`${id}-site`}
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
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
                    onChange={(event) => setUsername(event.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Password" htmlFor={`${id}-password`}>
                  <SecretInput
                    id={`${id}-password`}
                    value={password}
                    onChange={setPassword}
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
                    onChange={(event) => setNumber(groupCardNumber(event.target.value))}
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
                    onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
                      setExpiry(
                        digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits,
                      );
                    }}
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
                    onChange={(value) => setCvc(value.replace(/\D/g, "").slice(0, 4))}
                    placeholder={editing ? "Saved" : "123"}
                  />
                </Field>
                <Field label="ZIP code" htmlFor={`${id}-zip`} className="col-span-2 sm:col-span-1">
                  <Input
                    id={`${id}-zip`}
                    value={zip}
                    onChange={(event) => setZip(event.target.value)}
                    placeholder={editing ? "Saved" : "Optional"}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <Field label="Name on the card" htmlFor={`${id}-holder`}>
                <Input
                  id={`${id}-holder`}
                  value={holder}
                  onChange={(event) => setHolder(event.target.value)}
                  placeholder={editing ? "Saved. Type to replace it." : undefined}
                  autoComplete="off"
                />
              </Field>
            </>
          )}
          <div className="rounded-xl border bg-subtle/60 p-3.5">
            <AccessPicker value={access} onChange={setAccess} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending} data-testid="vault-save">
              {pending && <Loader2 className="animate-spin" />}
              {editing ? "Save" : kind === "login" ? "Save login" : "Save card"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
