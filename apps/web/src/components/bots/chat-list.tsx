"use client";

import { CalendarClock, Mail, MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { TimeAgo } from "@/components/time-ago";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { newDirectChat } from "@/lib/actions";

export function ChatList({
  chats,
  botId,
  botName,
}: {
  chats: { id: string; kind: string; title: string; lastActivityAt: string }[];
  botId: string;
  botName: string;
}) {
  const router = useRouter();
  // Chats come newest first; the newest direct one is the current conversation.
  const latestDirect = chats.find((chat) => chat.kind === "direct")?.id;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="outline"
          onClick={async () => {
            const result = await newDirectChat(botId);
            if (result.ok) router.push(`/chats/${result.data.chatId}`);
            else toast.error(result.error);
          }}
        >
          <Plus />
          New chat with {botName}
        </Button>
      </div>
      <div className="divide-y rounded-xl border bg-card">
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
            <span className="flex-1 text-[14px]">
              {chat.kind === "scheduled"
                ? "Scheduled tasks"
                : chat.kind === "inbox"
                  ? "Email"
                  : chat.id === latestDirect
                    ? chat.title
                    : `${chat.title} (earlier)`}
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
