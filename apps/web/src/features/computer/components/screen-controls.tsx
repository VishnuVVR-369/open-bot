"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Expand, Hand } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import type { AppState } from "@/lib/types";
import { type ScreenHandle } from "./screen-view";
import { useComputer } from "../hooks";
import { HandBackButton, TakeOverButton } from "./takeover-buttons";

/** The bar under a screen: take over or hand back, plus its teammate's requests. */
export function ScreenControls({
  screenId,
  initial,
  handleRef,
  expand = true,
  showRequests = true,
}: {
  screenId: string;
  initial?: AppState;
  handleRef?: React.RefObject<ScreenHandle | null>;
  expand?: boolean;
  /** Show the teammate's takeover request here. Off where the page already lists it. */
  showRequests?: boolean;
}) {
  const { screen, online } = useComputer(initial);
  const queryClient = useQueryClient();
  const info = screen(screenId);
  if (!info) return null;
  const youHaveControl = info.activity === "you";
  const request = showRequests ? info.requests[0] : undefined;
  const name = info.teammate.name;
  if (!request && !youHaveControl && !online && !expand) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {request && !youHaveControl && (
        <div
          className="flex flex-col gap-2.5 rounded-xl border border-attention/40 bg-attention/[0.07] p-3.5"
          role="status"
        >
          <div className="flex items-start gap-2.5">
            <Hand className="mt-0.5 size-4 shrink-0 text-attention-ink" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13.5px] font-medium">{name} needs you to take over</span>
              <span className="text-[13px] text-muted-foreground">{request.reason}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 pl-6.5">
            {online ? (
              <TakeOverButton screenId={screenId} size="sm" />
            ) : (
              <span className="mr-1.5 text-[12.5px] text-muted-foreground">
                You can take over once the computer is back.
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await attempt(api.takeovers.dismiss({ takeoverId: request.id }));
                if (!result.ok) toast.error(result.error);
                await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
              }}
            >
              Not now
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted-foreground">
          {youHaveControl
            ? `${name} can't use this screen until you hand it back.`
            : info.activity === "working"
              ? `Watching ${name}. Take over at any time; ${name} stops right away.`
              : info.activity === "idle"
                ? `${name} isn't using the screen. Take over to sign in to sites; every teammate gets the sign-in.`
                : info.activity === "asleep"
                  ? `Sign-ins you make here work on every teammate's screen.`
                  : ""}
        </p>
        {youHaveControl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Paste your clipboard into the screen"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    handleRef?.current?.pasteText(text);
                    handleRef?.current?.focus();
                    toast("Clipboard sent", {
                      description: "Press Ctrl+V on the screen to paste it.",
                    });
                  } catch {
                    toast.error("Allow clipboard access to paste into the screen.");
                  }
                }}
              >
                <ClipboardPaste />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send your clipboard</TooltipContent>
          </Tooltip>
        )}
        {expand && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" asChild>
                <Link href={`/computer?screen=${screenId}`} aria-label="Open the computer">
                  <Expand />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open the computer</TooltipContent>
          </Tooltip>
        )}
        {youHaveControl ? (
          <HandBackButton screenId={screenId} teammateName={name} />
        ) : (
          online && <TakeOverButton screenId={screenId} />
        )}
      </div>
    </div>
  );
}

/** Pick which teammate's screen to watch. */
