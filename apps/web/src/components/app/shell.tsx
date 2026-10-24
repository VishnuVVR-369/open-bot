"use client";

import { Hand, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useComputer } from "@/components/computer/computer-panel";
import type { AppState } from "@/lib/types";
import { CommandMenuProvider } from "./command-menu";
import { Sidebar } from "./sidebar";

/** A thin amber bar across the app while you hold a screen, so you never forget a bot is paused. */
function ControlBanner({ initial }: { initial: AppState }) {
  const { controlled, screen } = useComputer(initial);
  const pathname = usePathname();
  if (controlled.length === 0 || pathname === "/computer") return null;
  const names = controlled.map((id) => screen(id)?.bot.name).filter(Boolean) as string[];
  const text =
    names.length === 1
      ? `You have control of ${names[0]}'s screen. ${names[0]} won't use it until you hand it back.`
      : `You have control of ${names.length} screens. Those teammates won't use them until you hand them back.`;
  return (
    <div className="flex min-h-9 shrink-0 items-center justify-center gap-2 bg-manual px-4 py-1.5 text-center text-[13px] font-medium text-black">
      <Hand className="size-4 shrink-0" />
      <span>
        {text}
        <Link
          href={`/computer?screen=${controlled[0]}`}
          className="ml-2 underline underline-offset-2"
        >
          Open {names.length === 1 ? "it" : "the computer"}
        </Link>
      </span>
    </div>
  );
}

export function Shell({ initial, children }: { initial: AppState; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <CommandMenuProvider>
      <div className="flex h-full flex-col">
        <ControlBanner initial={initial} />
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[264px] shrink-0 border-r border-sidebar-border lg:block">
            <Sidebar initial={initial} />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 lg:hidden">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open menu"
                onClick={() => setMenuOpen(true)}
              >
                <Menu />
              </Button>
              <Link href="/">
                <Wordmark />
              </Link>
            </header>
            <main className="min-h-0 flex-1 bg-surface">{children}</main>
          </div>
        </div>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="w-[284px] p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <Sidebar initial={initial} onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
    </CommandMenuProvider>
  );
}
