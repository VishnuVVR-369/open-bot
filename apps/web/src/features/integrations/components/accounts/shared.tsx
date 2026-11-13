"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  capabilityOption,
  integration,
  type AccountCapability,
  type AccountConnectionKind,
  type IntegrationIcon,
} from "@open-bot/domain";
import { CalendarDays, Copy, Mail, NotebookText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { refreshForAppEvent } from "@/lib/client/refresh";
import { api } from "@/lib/client/rpc";
import type { AccountsSetupView, ProviderSetupView } from "@/lib/types";

const ICONS: Record<IntegrationIcon, typeof Mail> = {
  mail: Mail,
  calendar: CalendarDays,
  notebook: NotebookText,
};

export function iconFor(kind: AccountConnectionKind) {
  return ICONS[integration(kind).icon];
}

/** The provider an integration signs in through, as setup describes it. */
export function providerSetup(
  setup: AccountsSetupView,
  kind: AccountConnectionKind,
): ProviderSetupView {
  const id = integration(kind).provider;
  return setup.providers.find((entry) => entry.id === id)!;
}

/** What a connection lets teammates do, in a few words. */
export function canSummary(kind: AccountConnectionKind, capabilities: AccountCapability[]): string {
  return capabilities
    .map((capability) => capabilityOption(kind, capability)?.short)
    .filter(Boolean)
    .join(", ");
}

export function useRefresh() {
  const queryClient = useQueryClient();
  return () => refreshForAppEvent(queryClient, { type: "connections" });
}

/** Go to the provider's sign-in page. */
export async function signIn(input: {
  kind: AccountConnectionKind;
  capabilities: AccountCapability[];
  teammateIds: string[] | null;
  accountId: string | null;
}): Promise<boolean> {
  const started = await attempt(api.accounts.connect(input));
  if (!started.ok) {
    toast.error("Couldn't start connecting", { description: started.error });
    return false;
  }
  window.location.assign(started.data.url);
  return true;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
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
