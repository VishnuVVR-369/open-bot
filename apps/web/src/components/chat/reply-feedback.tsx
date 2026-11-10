"use client";

import { MAX_LESSON_CHARS } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import type { RunView } from "@/lib/types";
import { cn, REVEAL_ON_RUN_HOVER } from "@/lib/utils";

type Rating = RunView["rating"];

function RateButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          className={cn(
            // A 32px target with a 16px glyph, like the reply's other actions.
            "size-8 text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
            // Shown on hover like the copy button, and always once you've picked it.
            active ? "text-foreground [&_svg]:fill-current" : REVEAL_ON_RUN_HOVER,
          )}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Thumbs up or down on a reply. A thumbs down asks what to change: the teammate can keep it as a
 * lesson it reads before every task, and try again right away.
 */
export function ReplyFeedback({
  run,
  botName,
  chatId,
}: {
  run: RunView;
  botName: string;
  chatId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  // What you just picked, until the chat reloads with it.
  const [picked, setPicked] = useState<{ rating: Rating } | null>(null);
  const rating = picked ? picked.rating : run.rating;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(true);
  const [pending, startTransition] = useTransition();
  // Sending the same "do it again" after a failure reuses its id, so it's never asked twice.
  const failedRedo = useRef<{ key: string; clientId: string } | null>(null);
  const switchId = useId();
  const anchor = useRef<HTMLSpanElement>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orpc.chats.get.key({ input: { chatId: chatId } }) });

  function rate(next: Rating) {
    const before = rating;
    setPicked({ rating: next });
    void attempt(api.runs.rate({ runId: run.id, rating: next })).then(async (result) => {
      if (result.ok) return refresh();
      setPicked({ rating: before });
      toast.error("Couldn't save that", { description: result.error });
    });
  }

  function send(redo: boolean) {
    startTransition(async () => {
      const key = JSON.stringify([run.id, text, remember]);
      const clientId =
        failedRedo.current?.key === key ? failedRedo.current.clientId : crypto.randomUUID();
      const result = await attempt(
        api.runs.feedback({ runId: run.id, text, remember, redo: redo ? { clientId } : null }),
      );
      failedRedo.current = !result.ok && redo ? { key, clientId } : null;
      if (!result.ok) {
        toast.error("Couldn't send your feedback", { description: result.error });
        return;
      }
      setOpen(false);
      setText("");
      await refresh();
      if (remember)
        toast(`${botName} will remember that`, {
          description: "It's a lesson they read before every task.",
          action: {
            label: "See lessons",
            onClick: () => router.push(`/bots/${run.botId}?tab=memory`),
          },
        });
    });
  }

  const canSend = text.trim().length > 0 && text.length <= MAX_LESSON_CHARS && !pending;

  return (
    <span
      className="flex items-center gap-0.5"
      data-testid="reply-feedback"
      // A rated reply keeps its whole action row in view, so the picked thumb never floats alone.
      data-pinned={open || rating ? true : undefined}
    >
      <RateButton
        label="Good reply"
        active={rating === "up"}
        onClick={() => rate(rating === "up" ? null : "up")}
      >
        <ThumbsUp />
      </RateButton>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <span className="flex" ref={anchor}>
            <RateButton
              label="Bad reply"
              active={rating === "down"}
              onClick={() => {
                if (open) return setOpen(false);
                if (rating === "down") return rate(null);
                rate("down");
                setOpen(true);
              }}
            >
              <ThumbsDown />
            </RateButton>
          </span>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="flex w-[340px] flex-col gap-3 p-3.5"
          data-testid="feedback-form"
          // The thumb itself closes it, rather than closing and then reopening it.
          onInteractOutside={(event) => {
            if (anchor.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend) send(true);
            }}
          >
            <Label htmlFor={`${switchId}-text`} className="text-[14px] font-medium">
              What should {botName} do differently?
            </Label>
            <Textarea
              id={`${switchId}-text`}
              autoFocus
              rows={3}
              value={text}
              maxLength={MAX_LESSON_CHARS}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (canSend) send(true);
                }
              }}
              placeholder="Keep it to a few bullets, and link your sources."
              className="min-h-20 resize-none text-[14px]"
            />
            <div className="flex items-center gap-2.5">
              <Switch id={switchId} size="sm" checked={remember} onCheckedChange={setRemember} />
              <Label htmlFor={switchId} className="text-[13px] font-normal text-muted-foreground">
                Remember this for future tasks
              </Label>
            </div>
            <div className="flex justify-end gap-2">
              {remember && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canSend}
                  onClick={() => send(false)}
                >
                  Just save
                </Button>
              )}
              <Button type="submit" size="sm" disabled={!canSend}>
                {pending && <Loader2 className="animate-spin" />}
                Try again with this
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </span>
  );
}
