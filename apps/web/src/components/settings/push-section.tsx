"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Monitor, Send, Smartphone, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TimeAgo } from "@/components/time-ago";
import { sendPushTest, subscribePush, unsubscribePush } from "@/lib/actions";
import { getJson } from "@/lib/client/api";

interface PushStatus {
  publicKey: string;
  devices: { endpoint: string; device: string; createdAt: string }[];
}

const noop = () => () => {};

/** Push needs a service worker and a push service; Electron has neither, but has native alerts. */
function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !/\bElectron\//.test(navigator.userAgent)
  );
}

/** "Chrome on macOS", from the user agent, to tell devices apart. */
export function deviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iPhone"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}

/** Push notifications on this device, and the other devices that get them. */
export function PushSection({ fallback }: { fallback: React.ReactNode }) {
  const supported = useSyncExternalStore(noop, pushSupported, () => null);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["push"],
    queryFn: () => getJson<PushStatus>("/api/push"),
    enabled: supported === true,
  });
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [pending, startTransition] = useTransition();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["push"] });

  // What this browser is subscribed with, if anything.
  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker
      .getRegistration("/")
      .then((existing) => existing?.pushManager.getSubscription())
      .then((subscription) => setEndpoint(subscription?.endpoint ?? null));
  }, [supported]);

  if (supported === null) return null;
  if (!supported) return <>{fallback}</>;

  const devices = status.data?.devices ?? [];
  const thisDevice = devices.some((device) => device.endpoint === endpoint);
  const others = devices.filter((device) => device.endpoint !== endpoint);
  const isIPhone = /iPhone|iPad/.test(navigator.userAgent);

  function turnOn() {
    startTransition(async () => {
      if (!status.data) return;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Notifications are blocked", {
          description: "Allow them for this site in your browser's settings, then try again.",
        });
        return;
      }
      try {
        const worker = await registration();
        const subscription =
          (await worker.pushManager.getSubscription()) ??
          (await worker.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(status.data.publicKey),
          }));
        const json = subscription.toJSON() as {
          endpoint: string;
          keys: { p256dh: string; auth: string };
        };
        const result = await subscribePush(json, deviceName(navigator.userAgent));
        if (!result.ok) throw new Error(result.error);
        setEndpoint(json.endpoint);
        await refresh();
      } catch (error) {
        toast.error("Couldn't turn on notifications", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function turnOff() {
    startTransition(async () => {
      const worker = await navigator.serviceWorker.getRegistration("/");
      const subscription = await worker?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      if (endpoint) await unsubscribePush(endpoint);
      setEndpoint(null);
      await refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="push-section">
      <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border bg-card px-4 py-3.5">
        <span className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">Notifications on this device</span>
          <span className="text-[13px] text-muted-foreground">
            Approvals, requests to take over, and replies, even when open-bot is closed.
          </span>
        </span>
        <span className="flex items-center gap-2 pt-0.5">
          {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Switch
            checked={thisDevice}
            disabled={pending || !status.data || endpoint === undefined}
            onCheckedChange={(checked) => (checked ? turnOn() : turnOff())}
            aria-label="Notifications on this device"
          />
        </span>
      </label>
      {isIPhone && !window.matchMedia("(display-mode: standalone)").matches && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          On iPhone, add open-bot to your Home Screen first: tap Share, then Add to Home Screen.
          Open it from there and turn notifications on.
        </p>
      )}
      {devices.length > 0 && (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {[...devices.filter((device) => device.endpoint === endpoint), ...others].map(
              (device) => {
                const mine = device.endpoint === endpoint;
                const Icon = /iPhone|Android/.test(device.device) ? Smartphone : Monitor;
                return (
                  <li
                    key={device.endpoint}
                    className="flex min-h-12 items-center gap-3 py-1.5 pr-2 pl-4"
                    data-testid="push-device"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[14px]">
                        {device.device || "A browser"}
                        {mine && <span className="text-muted-foreground"> · this device</span>}
                      </span>
                      <span className="text-[12.5px] text-muted-foreground">
                        Added <TimeAgo date={device.createdAt} />
                      </span>
                    </span>
                    {!mine && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Stop notifications to ${device.device || "this browser"}`}
                        onClick={async () => {
                          await unsubscribePush(device.endpoint);
                          await refresh();
                        }}
                      >
                        <X />
                      </Button>
                    )}
                  </li>
                );
              },
            )}
          </ul>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await sendPushTest();
                if (!result.ok) toast.error("Couldn't send it", { description: result.error });
                else
                  toast(
                    result.data.sent === 1
                      ? "Sent to 1 device"
                      : `Sent to ${result.data.sent} devices`,
                    {
                      description: "This one shows it only while open-bot is in the background.",
                    },
                  );
              })
            }
          >
            <Send />
            Send a test
          </Button>
        </div>
      )}
    </div>
  );
}
