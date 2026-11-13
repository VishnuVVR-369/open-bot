"use client";

import { BellRing, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function NotificationsSection() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  useEffect(
    () =>
      setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    [],
  );
  if (permission === "granted") {
    return (
      <p className="flex items-center gap-2 text-[14px]">
        <Check className="size-4 text-done" /> Desktop alerts are on. You get one when a teammate
        finishes or needs you while this tab is in the background.
      </p>
    );
  }
  if (permission === "unsupported")
    return (
      <p className="text-[14px] text-muted-foreground">
        This browser doesn&apos;t support desktop alerts.
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        onClick={async () => setPermission(await Notification.requestPermission())}
      >
        <BellRing />
        Turn on desktop alerts
      </Button>
      {permission === "denied" && (
        <p className="text-[13px] text-muted-foreground">
          Alerts are blocked for this site. Allow them in your browser&apos;s site settings.
        </p>
      )}
    </div>
  );
}
