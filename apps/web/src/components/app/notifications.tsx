"use client";

import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Bell, BellRing } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { markNotificationsRead } from "@/lib/actions";
import { queryKeys, useNotifications } from "@/lib/client/queries";
import { chatHref, cn, plainText } from "@/lib/utils";

export function NotificationsButton({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useNotifications(open);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, [open]);

  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next && count > 0) {
      await markNotificationsRead();
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={count ? `${count} unread notifications` : "Notifications"}
          className="relative"
        >
          <Bell />
          {count > 0 && (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-live ring-2 ring-sidebar" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          {permission === "default" && (
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0"
              onClick={async () => setPermission(await Notification.requestPermission())}
            >
              <BellRing />
              Turn on desktop alerts
            </Button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {isLoading && <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>}
          {data?.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing yet. Your teammates will tell you here when they finish or need you.
            </p>
          )}
          {data?.map((notification) => (
            <button
              key={notification.id}
              onClick={() => {
                if (notification.chatId)
                  router.push(chatHref(notification.chatId, notification.runId));
                void onOpenChange(false);
              }}
              className="flex w-full gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted"
            >
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  notification.readAt ? "bg-transparent" : "bg-live",
                )}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13.5px] leading-snug font-medium">{notification.title}</span>
                {notification.body && (
                  <span className="line-clamp-2 text-[13px] text-muted-foreground">
                    {plainText(notification.body)}
                  </span>
                )}
                <span className="text-xs text-muted-foreground/80">
                  {formatDistanceToNowStrict(new Date(notification.createdAt), { addSuffix: true })}
                </span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
