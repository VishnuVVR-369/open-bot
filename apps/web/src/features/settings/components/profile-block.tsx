"use client";

import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppState } from "@/features/app-shell";

/** Who's signed in: the owner's mark, name and email, at the top of Account. */
export function ProfileBlock() {
  const { data: state } = useAppState();
  if (!state) return <Skeleton className="h-[72px] w-full rounded-xl" />;
  const { name, email } = state.user;
  return (
    <section
      aria-label="Your account"
      className="flex items-center gap-4 rounded-xl border bg-card px-4 py-4"
      data-testid="profile-block"
    >
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-foreground/85 to-foreground text-[17px] font-semibold text-background"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-medium">{name}</span>
        <span className="truncate text-[13.5px] text-muted-foreground">{email}</span>
      </span>
      <a
        href="#security"
        className="flex shrink-0 items-center gap-0.5 rounded-md text-[13px] font-medium text-foreground/80 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12"
      >
        Password and passkeys
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </a>
    </section>
  );
}
