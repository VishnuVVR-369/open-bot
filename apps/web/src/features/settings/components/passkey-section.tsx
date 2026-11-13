"use client";

import { relativeTime } from "@open-bot/domain";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { authClient } from "@/lib/auth-client";
import { passkeyLabel } from "@/lib/passkey-name";

type Passkey = NonNullable<ReturnType<typeof authClient.useListPasskeys>["data"]>[number];

function PasskeyRow({ passkey, onRemoved }: { passkey: Passkey; onRemoved: () => void }) {
  const label = passkeyLabel(passkey.name);
  return (
    <li className="flex min-h-14 items-center gap-3 py-2 pr-2 pl-4 text-[14px]">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <time
        dateTime={new Date(passkey.createdAt).toISOString()}
        title={new Date(passkey.createdAt).toLocaleString()}
        className="shrink-0 text-[12.5px] text-muted-foreground"
      >
        Added {relativeTime(passkey.createdAt)}
      </time>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              {label} can't sign you in anymore. Remove it from the device too, in its password
              settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const result = await authClient.passkey.deletePasskey({ id: passkey.id });
                if (result?.error)
                  toast.error(result.error.message ?? "The passkey wasn't removed.");
                else toast("Passkey removed");
                onRemoved();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function PasskeySection() {
  const passkeys = authClient.useListPasskeys();
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {passkeys.data && passkeys.data.length === 0 && (
        <p
          className="flex items-center gap-3 rounded-xl border px-4 py-3 text-[14px] text-muted-foreground"
          data-testid="no-passkeys"
        >
          <KeyRound className="size-4" />
          No passkeys yet
        </p>
      )}
      {passkeys.data && passkeys.data.length > 0 && (
        <ul className="divide-y divide-border/70 rounded-xl border bg-card" data-testid="passkeys">
          {passkeys.data.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              onRemoved={() => void passkeys.refetch()}
            />
          ))}
        </ul>
      )}
      <Button
        variant="outline"
        className="w-fit"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          // The server names it after where it's kept, or this browser.
          const result = await authClient.passkey.addPasskey();
          setPending(false);
          if (result?.error) toast.error(result.error.message ?? "The passkey wasn't added.");
          else {
            toast("Passkey added");
            void passkeys.refetch();
          }
        }}
      >
        {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Add a passkey
      </Button>
    </div>
  );
}
