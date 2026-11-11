"use client";

import { CalendarClock, Mail, MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { TimeAgo } from "@/components/time-ago";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";

export function ChatList({
  chats,
  botId,
  botName,
}: {
  chats: { id: string; kind: string; title: string; main: boolean; lastActivityAt: string }[];
  botId: string;
  botName: string;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="outline"
          onClick={async () => {
            const result = await attempt(api.chats.newDirect({ botId }));
            if (result.ok) router.push(`/chats/${result.data.chatId}`);
            else toast.error(result.error);
          }}
        >
          <Plus />
          New chat with {botName}
        </Button>
      </div>
      <div className="divide-y divide-border/70 rounded-xl border bg-card">
        {chats.map((chat) => (
          <Link
            key={chat.id}
            href={`/chats/${chat.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
          >
            {chat.kind === "scheduled" ? (
              <CalendarClock className="size-4 text-muted-foreground" />
            ) : chat.kind === "inbox" ? (
              <Mail className="size-4 text-muted-foreground" />
            ) : (
              <MessageSquare className="size-4 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-1 items-center gap-2 text-[14px]">
              <span className="truncate">
                {chat.kind === "scheduled"
                  ? "Scheduled tasks"
                  : chat.kind === "inbox"
                    ? "Email"
                    : chat.title}
              </span>
              {chat.main && (
                <Badge variant="secondary" title="Where work that isn't started from a chat arrives">
                  Main
                </Badge>
              )}
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              <TimeAgo date={chat.lastActivityAt} />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
