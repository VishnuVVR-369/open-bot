"use client";

import {
  ACCOUNT_CONNECTION_KINDS,
  integration,
  type AccountConnectionKind,
} from "@open-bot/domain";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccountsSetup } from "../../hooks";
import type { AccountsSetupView, ConnectionTestView, ConnectionView } from "@/lib/types";
import { iconFor } from "./shared";
import { ClientDialog } from "./client-dialog";
import { ConnectDialog } from "./connect-dialog";
import { AccountRow } from "./account-row";

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
      <ul className="flex flex-col divide-y divide-border/70 rounded-xl border bg-card">
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
