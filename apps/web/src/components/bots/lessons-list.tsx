"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { GraduationCap, ThumbsDown, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteLesson } from "@/lib/actions";
import { useLessons } from "@/lib/client/queries";
import { chatHref } from "@/lib/utils";

/** What a teammate learned from your thumbs down, which it reads before every task. */
export function LessonsList({ botId, name }: { botId: string; name: string }) {
  const { data: lessons, refetch } = useLessons(botId);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(id: string) {
    setRemoving(id);
    const result = await deleteLesson(id);
    if (!result.ok) toast.error("Couldn't remove it", { description: result.error });
    await refetch();
    setRemoving(null);
  }

  return (
    <section className="flex flex-col gap-4" data-testid="lessons">
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px] font-medium">Lessons</span>
        {lessons && lessons.length > 0 && (
          <span className="text-[13px] text-muted-foreground">
            {name} reads these before every task. They come from your feedback on replies.
          </span>
        )}
      </div>
      {!lessons ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : lessons.length === 0 ? (
        <div className="flex items-start gap-3 rounded-xl border border-dashed px-4 py-4">
          <GraduationCap className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Nothing yet. When a reply misses, press{" "}
            <ThumbsDown className="inline size-3.5 -translate-y-px" aria-label="thumbs down" /> and
            say what to change. {name} keeps it as a lesson and reads it before every task.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {lessons.map((lesson) => (
            <li
              key={lesson.id}
              className="flex min-h-12 items-start gap-3 py-2.5 pr-2 pl-4"
              data-testid="lesson"
            >
              <GraduationCap className="mt-[3px] size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] break-words whitespace-pre-wrap">{lesson.text}</span>
                <span className="text-[12.5px] text-muted-foreground">
                  {formatDistanceToNowStrict(new Date(lesson.createdAt), { addSuffix: true })}
                  {lesson.chatId && lesson.runId && (
                    <>
                      {" · "}
                      <Link
                        href={chatHref(lesson.chatId, lesson.runId)}
                        className="underline-offset-4 hover:text-foreground hover:underline"
                      >
                        See the reply
                      </Link>
                    </>
                  )}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Forget this lesson"
                    disabled={removing === lesson.id}
                    onClick={() => void remove(lesson.id)}
                  >
                    <X />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Forget this</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
