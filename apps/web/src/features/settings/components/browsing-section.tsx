"use client";

import { describeEgress, type EgressStatusView } from "@open-bot/api";
import {
  EGRESS_OPTIONS,
  PHONE_MODE_OPTIONS,
  type EgressMode,
  type PhoneMode,
} from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Laptop, Smartphone } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
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
import { EgressPathIcon, egressPathTone } from "@/features/computer";
import { useAppState } from "@/features/app-shell";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { cn } from "@/lib/utils";
import { Choice } from "./choice";

type Phone = EgressStatusView["phones"][number];

/** A device's state in a few words: carrying traffic, standing by, or why it isn't. */
function DeviceState({
  tone,
  children,
}: {
  tone: "on" | "idle" | "off";
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "on" && "bg-done",
          tone === "idle" && "bg-working",
          tone === "off" && "bg-muted-foreground/40",
        )}
      />
      {children}
    </span>
  );
}

function phoneLine(phone: Phone, status: EgressStatusView) {
  const agent = status.agents.find((entry) => entry.kind === "phone" && entry.id === phone.id);
  if (phone.online && agent?.role === "active")
    return <DeviceState tone="on">Carrying the computer&apos;s browsing</DeviceState>;
  if (phone.online) return <DeviceState tone="idle">Standing by</DeviceState>;
  if (phone.waking) return <DeviceState tone="idle">Waking up</DeviceState>;
  if (phone.unavailable) return <DeviceState tone="off">{phone.unavailable.message}</DeviceState>;
  if (phone.unanswered)
    return <DeviceState tone="off">Didn&apos;t answer. Open open-bot on it.</DeviceState>;
  return (
    <DeviceState tone="off">
      {phone.lastUsedAt ? (
        <>
          Last used <TimeAgo date={phone.lastUsedAt} />
        </>
      ) : (
        "Never used"
      )}
    </DeviceState>
  );
}

function RemovePhone({ phone }: { phone: Phone }) {
  const queryClient = useQueryClient();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Remove ${phone.name}`}>
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {phone.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops carrying the computer&apos;s browsing right away. To use it again, turn it on
            in the phone app under Settings, Phone connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              const result = await attempt(api.egress.revokeDevice({ deviceId: phone.id }));
              if (!result.ok) toast.error(result.error);
              await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Settings → Browsing: where the computer's browser goes online now, the Mac and phones that can
 * carry it, and when each may.
 */
export function BrowsingSection() {
  const { data: state } = useAppState();
  const egress = state?.computer.egress;
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  if (!egress) return null;
  const path = describeEgress(egress);
  const tone = egressPathTone(egress.path);
  const macs = egress.agents.filter((agent) => agent.kind === "desktop");

  function save(work: () => Promise<unknown>) {
    startTransition(async () => {
      const result = await attempt(work());
      if (!result.ok) toast.error(result.error);
      await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
    });
  }

  return (
    <>
      <div className="flex flex-col rounded-xl border bg-card" data-testid="browsing-devices">
        <div className="flex items-start gap-3 px-4 py-3.5" data-testid="browsing-path">
          <EgressPathIcon
            path={egress.path}
            className={cn(
              "mt-0.5 size-4 shrink-0",
              tone === "on" && "text-done",
              tone === "attention" && "text-attention",
              tone !== "on" && tone !== "attention" && "text-muted-foreground",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] font-medium">{path.label}</span>
            {path.detail && (
              <span className="text-[13px] text-muted-foreground">{path.detail}</span>
            )}
          </span>
        </div>
        <ul className="flex flex-col divide-y divide-border/70 border-t">
          {macs.length === 0 ? (
            <li className="flex items-center gap-3 px-4 py-3">
              <Laptop className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px]">Desktop app</span>
                <DeviceState tone="off">Not connected</DeviceState>
              </span>
            </li>
          ) : (
            macs.map((mac) => (
              <li key={mac.id} className="flex items-center gap-3 px-4 py-3">
                <Laptop className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px]">{mac.name}</span>
                  {mac.role === "active" ? (
                    <DeviceState tone="on">Carrying the computer&apos;s browsing</DeviceState>
                  ) : (
                    <DeviceState tone="idle">Standing by</DeviceState>
                  )}
                </span>
              </li>
            ))
          )}
          {egress.phones.map((phone) => (
            <li
              key={phone.id}
              className="flex items-center gap-3 px-4 py-3"
              data-testid={`paired-phone-${phone.id}`}
            >
              <Smartphone className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[14px]">{phone.name}</span>
                {phoneLine(phone, egress)}
              </span>
              <RemovePhone phone={phone} />
            </li>
          ))}
        </ul>
        {egress.phones.length === 0 && (
          <p className="border-t px-4 py-3 text-[13px] text-muted-foreground">
            To browse through your phone too, open the open-bot app on it and go to Settings, Phone
            connection.
          </p>
        )}
      </div>

      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-label="Where the browser goes online"
      >
        {EGRESS_OPTIONS.map((option) => (
          <Choice
            key={option.value}
            checked={egress.mode === option.value}
            disabled={pending}
            title={option.label}
            description={option.description}
            onSelect={() => save(() => api.egress.setMode({ mode: option.value as EgressMode }))}
          />
        ))}
      </div>

      {egress.phones.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="px-1 text-[13.5px] font-medium">When your phone helps</h3>
          <div
            className="flex flex-col gap-2"
            role="radiogroup"
            aria-label="When your phone carries the browsing"
          >
            {PHONE_MODE_OPTIONS.map((option) => (
              <Choice
                key={option.value}
                checked={egress.phoneMode === option.value}
                disabled={pending}
                title={option.label}
                description={option.description}
                onSelect={() =>
                  save(() => api.egress.setPhoneMode({ mode: option.value as PhoneMode }))
                }
              />
            ))}
          </div>
        </div>
      )}

      <p className="max-w-[60ch] px-1 text-[13px] text-muted-foreground">
        Some sites ask you to sign in again when browsing moves between your Mac, your phone and the
        cloud. If one of yours does, choose Only through my devices.
      </p>
    </>
  );
}
