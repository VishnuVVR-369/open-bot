"use client";

import { Network } from "lucide-react";
import Link from "next/link";
import { useComputer } from "@/components/computer/computer-panel";
import { DesktopView } from "@/components/computer/desktop-view";
import type { ChatData } from "@/lib/types";

/** A swarm helper's own screen, which you can watch while it works on its part. */
export function HelperScreen({ helper }: { helper: NonNullable<ChatData["helper"]> }) {
  const working = helper.state === "running" || helper.state === "queued";
  const { screens } = useComputer();
  const up = screens.some((screen) => screen.id === helper.screenId && screen.state === "running");
  return (
    <section aria-label="Helper's screen" className="flex flex-col gap-3">
      <div className="rounded-[22px] bg-bezel p-2.5">
        <div className="relative aspect-[16/10] w-full overflow-hidden rounded-[12px] bg-black">
          {helper.state === "running" && up ? (
            <DesktopView screenId={helper.screenId} mode="view" className="absolute inset-0" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center text-bezel-foreground/70">
              <span className="text-[14px] font-medium text-bezel-foreground">
                {working ? "Not on its screen yet" : "Its screen closed when it finished"}
              </span>
              <span className="text-[12.5px]">
                {working
                  ? "It opens a screen of its own when it first uses the browser."
                  : "Its result went back to the teammate that started the swarm."}
              </span>
            </div>
          )}
        </div>
      </div>
      <p className="flex items-start gap-2 text-[12.5px] leading-snug text-muted-foreground">
        <Network className="mt-0.5 size-3.5 shrink-0" />
        <span>
          One of the helpers in{" "}
          <Link
            href={`/chats/${helper.swarmChatId}#run-${helper.swarmRunId}`}
            className="text-foreground underline-offset-2 hover:underline"
          >
            {helper.swarmTitle}
          </Link>
          , on a screen of its own. You can watch; it works on its part alone.
        </span>
      </p>
    </section>
  );
}
