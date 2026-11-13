"use client";

import { Sparkles } from "lucide-react";
import { Fragment } from "react";
import { useAppState } from "@/lib/client/queries";
import { cn } from "@/lib/utils";

/** Your message, with the skills it runs (`/name`) shown as chips. */
export function MessageText({ text, className }: { text: string; className?: string }) {
  const { data: state } = useAppState();
  const names = new Set(state?.skills.map((skill) => skill.name) ?? []);
  if (names.size === 0) return <>{text}</>;
  const parts = text.split(/((?:^|(?<=\s))\/[a-z0-9]+(?:-[a-z0-9]+)*(?=$|[\s.,;:!?)]))/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("/") && names.has(part.slice(1)) ? (
          <span
            key={index}
            className={cn(
              "inline-flex items-center gap-1 rounded-md bg-current/12 px-1.5 align-baseline font-mono text-[0.9em] font-medium",
              className,
            )}
            data-testid="skill-chip"
          >
            <Sparkles className="size-3 shrink-0" />
            {part.slice(1)}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
