"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  EyeOff,
  Globe,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { TimeAgo } from "@/components/time-ago";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteVaultItem } from "@/lib/actions";
import { queryKeys, useAppState, useVault } from "@/lib/client/queries";
import type { VaultItemView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VaultDialog } from "./vault-dialog";

const BRAND_STYLE: Record<string, string> = {
  Visa: "from-[#1a1f71] to-[#2b3a9a]",
  Mastercard: "from-[#2b2b2b] to-[#4a4a4a]",
  Amex: "from-[#1f6fb2] to-[#2e8bd6]",
  Discover: "from-[#d9661f] to-[#f08a3c]",
};

/** A small card face: the brand and its last four digits. */
function CardFace({ hint }: { hint: string }) {
  const brand = hint.split(" ")[0] ?? "Card";
  const last4 = hint.slice(-4);
  return (
    <span
      className={cn(
        "flex h-9 w-14 shrink-0 flex-col justify-between rounded-[7px] bg-gradient-to-br px-1.5 py-1 text-white shadow-sm ring-1 ring-black/10",
        BRAND_STYLE[brand] ?? "from-zinc-600 to-zinc-500",
      )}
      aria-hidden
    >
      <span className="text-[8.5px] leading-none font-semibold tracking-wide uppercase opacity-90">
        {brand}
      </span>
      <span className="font-mono text-[9.5px] leading-none tabular-nums opacity-95">
        •• {last4}
      </span>
    </span>
  );
}

function Access({ botIds }: { botIds: string[] | null }) {
  const { data: state } = useAppState();
  if (botIds === null)
    return (
      <span className="flex items-center gap-1.5">
        <Users className="size-3.5" />
        Every teammate
      </span>
    );
  const bots = botIds
    .map((id) => state?.bots.find((bot) => bot.id === id))
    .filter((bot) => bot !== undefined);
  if (bots.length === 0) return <span>No current teammate</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex -space-x-1">
        {bots.slice(0, 4).map((bot) => (
          <BotAvatar
            key={bot.id}
            name={bot.name}
            color={bot.color}
            emoji={bot.emoji}
            size="xs"
            className="ring-2 ring-card"
          />
        ))}
      </span>
      {bots.length === 1 ? `Only ${bots[0]!.name}` : `${bots.length} teammates`}
    </span>
  );
}

function DeleteItem({ item }: { item: VaultItemView }) {
  const queryClient = useQueryClient();
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${item.name}`}>
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {item.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Teammates can&apos;t use it anymore.{" "}
            {item.kind === "card" && "Past purchases stay in their history. "}
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              const result = await deleteVaultItem(item.id);
              if (!result.ok) toast.error(result.error);
              await queryClient.invalidateQueries({ queryKey: queryKeys.vault });
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ItemRow({ item }: { item: VaultItemView }) {
  return (
    <li
      className="group relative flex min-h-16 items-center gap-3.5 px-4 py-3"
      data-testid="vault-item"
    >
      {item.kind === "card" ? (
        <CardFace hint={item.hint} />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-muted-foreground">
          <KeyRound className="size-4" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium">{item.name}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-muted-foreground">
          {item.kind === "login" ? (
            <>
              <span className="truncate">{item.hint}</span>
              <span className="flex items-center gap-1">
                <Globe className="size-3.5" />
                {item.domain}
              </span>
            </>
          ) : (
            <span className="font-mono tabular-nums">{item.hint}</span>
          )}
          <Access botIds={item.botIds} />
          <span>
            {item.lastUsedAt ? (
              <>
                Used <TimeAgo date={item.lastUsedAt} />
              </>
            ) : (
              "Not used yet"
            )}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <VaultDialog
          kind={item.kind}
          item={item}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${item.name}`}>
              <Pencil />
            </Button>
          }
        />
        <DeleteItem item={item} />
      </div>
    </li>
  );
}

function Section({
  title,
  description,
  items,
  kind,
}: {
  title: string;
  description: string;
  items: VaultItemView[];
  kind: VaultItemView["kind"];
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title} data-testid={`vault-${kind}s`}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <p className="text-[13px] text-muted-foreground">{description}</p>
        </div>
        {items.length > 0 && (
          <VaultDialog
            kind={kind}
            trigger={
              <Button variant="outline" size="sm">
                <Plus />
                {kind === "login" ? "Add login" : "Add card"}
              </Button>
            }
          />
        )}
      </div>
      {items.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-3.5 rounded-xl border border-dashed px-4 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-muted-foreground">
            {kind === "login" ? <KeyRound className="size-4" /> : <CreditCard className="size-4" />}
          </span>
          <p className="min-w-0 flex-1 text-[13.5px] text-muted-foreground">
            {kind === "login"
              ? "No logins yet. Save one, and teammates sign in on that site without asking you."
              : "No cards yet. Save one, and give a teammate a budget to buy things for you."}
          </p>
          <VaultDialog
            kind={kind}
            trigger={
              <Button variant="outline" size="sm">
                <Plus />
                {kind === "login" ? "Add login" : "Add card"}
              </Button>
            }
          />
        </div>
      )}
    </section>
  );
}

const PROMISES = [
  {
    icon: EyeOff,
    title: "Never seen",
    text: "Teammates type it on the computer's screen without it ever passing through them or the chat.",
  },
  {
    icon: Globe,
    title: "Only on its site",
    text: "A login fills only when the browser shows its site, so a look-alike page can't collect it.",
  },
  {
    icon: Wallet,
    title: "Within a budget",
    text: "A card works only for a purchase within the teammate's monthly budget, and larger ones ask you.",
  },
  {
    icon: Lock,
    title: "Encrypted",
    text: "Stored encrypted, and never sent back to this app. Editing replaces what's saved.",
  },
];

/** Logins and cards, and how teammates use them. */
export function VaultView() {
  const { data, isLoading } = useVault();
  const { data: state } = useAppState();
  const items = data ?? [];
  const logins = items.filter((item) => item.kind === "login");
  const cards = items.filter((item) => item.kind === "card");
  const budgeted = state?.bots.length ?? 0;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-8">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="Logins"
        description="Sign-ins teammates fill in on the right site."
        items={logins}
        kind="login"
      />
      <Section
        title="Cards"
        description={
          budgeted > 0
            ? "For purchases within each teammate's monthly budget. Set budgets on a teammate's Spending tab."
            : "For purchases within each teammate's monthly budget."
        }
        items={cards}
        kind="card"
      />
      <section
        className="grid gap-x-6 gap-y-5 border-t pt-8 sm:grid-cols-2"
        aria-label="How it stays safe"
      >
        {PROMISES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="flex gap-3">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13.5px] font-medium">{title}</span>
              <span className="text-[13px] text-muted-foreground">{text}</span>
            </div>
          </div>
        ))}
        <p className="text-[12.5px] text-muted-foreground sm:col-span-2">
          A page can still show what was typed, like a card number at checkout, in the screenshots a
          teammate takes. For a sign-in that needs a code from your phone, the teammate asks you to{" "}
          <Link href="/computer" className="underline underline-offset-2">
            take over
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
