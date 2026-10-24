"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
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
import { archiveBot, setPrimaryBot } from "@/lib/actions";
import { queryKeys } from "@/lib/client/queries";

export function BotDangerZone({
  botId,
  name,
  isPrimary,
}: {
  botId: string;
  name: string;
  isPrimary: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const queryClient = useQueryClient();

  return (
    <section className="flex flex-col gap-4 border-t pt-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">Lead teammate</span>
          <span className="text-[13px] text-muted-foreground">
            {isPrimary
              ? `${name} answers group messages that don't @mention anyone, and hands work to others.`
              : "The lead answers group messages that don't @mention anyone."}
          </span>
        </div>
        <Button
          variant="outline"
          disabled={isPrimary || pending}
          onClick={() =>
            startTransition(async () => {
              const result = await setPrimaryBot(botId);
              if (!result.ok) toast.error(result.error);
              await queryClient.invalidateQueries({ queryKey: queryKeys.state });
              router.refresh();
            })
          }
        >
          <Crown />
          {isPrimary ? `${name} is the lead` : `Make ${name} the lead`}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">Archive {name}</span>
          <span className="text-[13px] text-muted-foreground">
            Stops their work and automations. Their files stay on the computer.
          </span>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Archive</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {name} stops what they&apos;re doing, their automations are paused, and their chats
                are hidden. Their workspace stays on the computer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep {name}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  startTransition(async () => {
                    const result = await archiveBot(botId);
                    if (!result.ok) {
                      toast.error(result.error);
                      return;
                    }
                    await queryClient.invalidateQueries({ queryKey: queryKeys.state });
                    router.push("/");
                  })
                }
              >
                Archive {name}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
