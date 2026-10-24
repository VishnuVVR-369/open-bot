"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Mail } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { removeEmailToken, saveEmailSettings } from "@/lib/actions";
import { getJson } from "@/lib/client/api";
import { queryKeys } from "@/lib/client/queries";
import type { EmailStatusView } from "@/lib/types";

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
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

/** An email address for every teammate, through Postmark. */
export function EmailSection() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.email,
    queryFn: () => getJson<EmailStatusView>("/api/email"),
  });
  const [domain, setDomain] = useState("");
  const [token, setToken] = useState("");
  const [pending, startTransition] = useTransition();
  const data = status.data;

  useEffect(() => {
    if (data) setDomain(data.domain ?? "");
  }, [data]);

  if (!data) return <div className="h-24 animate-pulse rounded-xl bg-subtle" />;
  const inboundUrl =
    typeof window === "undefined"
      ? data.inboundPath
      : `${window.location.origin}${data.inboundPath}`;
  const dirty = domain.trim() !== (data.domain ?? "") || token.trim() !== "";

  function save() {
    startTransition(async () => {
      const result = await saveEmailSettings({ domain, token });
      if (!result.ok) {
        toast.error("Couldn't save email", { description: result.error });
        return;
      }
      setToken("");
      toast("Email saved");
      await queryClient.invalidateQueries({ queryKey: queryKeys.email });
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="email-section">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !pending) save();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="email-domain">Domain</Label>
          <Input
            id="email-domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="team.example.com"
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email-token">Postmark server token</Label>
          <Input
            id="email-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={data.tokenHint ? `Saved: ${data.tokenHint}` : "For sending"}
            autoComplete="off"
          />
        </div>
        {dirty && (
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </div>
        )}
      </form>

      <div className="flex flex-col gap-1.5 rounded-xl border bg-subtle/50 px-4 py-3">
        <span className="text-[13px] font-medium">Inbound webhook</span>
        <span className="text-[12.5px] text-muted-foreground">
          In Postmark, point your domain&apos;s inbound stream here. Mail to any teammate&apos;s
          address starts them in their Email chat.
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]" data-testid="inbound-url">
            {inboundUrl}
          </code>
          <CopyButton text={inboundUrl} label="Copy the webhook address" />
        </span>
        {data.lastReceivedAt && (
          <span className="text-[12px] text-muted-foreground">
            Last email <TimeAgo date={data.lastReceivedAt} />
          </span>
        )}
      </div>

      {data.addresses.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border bg-card" aria-label="Addresses">
          {data.addresses.map((entry) => (
            <li
              key={entry.botId}
              className="flex min-h-11 items-center gap-3 py-1 pr-2 pl-4"
              data-testid="email-address"
            >
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <span className="w-24 shrink-0 truncate text-[13.5px]">{entry.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground">
                {entry.address}
              </code>
              <CopyButton text={entry.address} label={`Copy ${entry.name}'s address`} />
            </li>
          ))}
        </ul>
      )}

      {data.tokenHint ? (
        <p className="text-[12.5px] text-muted-foreground">
          Teammates can send email, and ask you before each one unless they work fully on their own.{" "}
          <button
            className="underline underline-offset-2 hover:text-foreground"
            onClick={async () => {
              const result = await removeEmailToken();
              if (!result.ok) toast.error(result.error);
              await queryClient.invalidateQueries({ queryKey: queryKeys.email });
            }}
          >
            Stop sending
          </button>
        </p>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          Without a token, teammates receive email but can&apos;t send it.
        </p>
      )}
    </div>
  );
}
